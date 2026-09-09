'use strict';

const AISHubClient = require('../lib/connection/AISHubClient');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { AIS_CONFIG } = require('../lib/constants');

const CFG = AIS_CONFIG.AISHUB;
const START = Date.parse('2026-09-06T10:00:00Z');
const envelope = (records) => JSON.stringify([
  {
    ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: records.length,
  }, records,
]);
const record = (fixTs, overrides = {}) => ({
  MMSI: 265552100,
  TIME: new Date(fixTs).toISOString().replace('T', ' ').replace('.000Z', ' GMT'),
  LATITUDE: 58.279,
  LONGITUDE: 12.279,
  SOG: 0,
  COG: 0,
  NAVSTAT: 0,
  NAME: 'KÖBÅT',
  ...overrides,
});

describe('AISHub: gammal cache får inte förnya positionsklockan', () => {
  let client;
  let logger;
  let events;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    client = new AISHubClient(logger, { get: () => null, set: () => {} });
    client._stopped = false; // Prova den riktiga svarsvägen utan nätverk/polltimer.
    events = [];
    for (const type of ['ais-message', 'vessel:seen', 'static-name']) {
      client.on(type, (data) => events.push({ type, data, at: Date.now() }));
    }
  });

  afterEach(() => {
    client.disconnect();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const positions = () => events.filter((event) => event.type === 'ais-message');
  const seen = () => events.filter((event) => event.type === 'vessel:seen');
  const receive = async (at, records) => {
    jest.setSystemTime(at);
    const delay = client._handleHttpResult({ statusCode: 200, body: envelope(records) }, 12);
    await jest.advanceTimersByTimeAsync(records.length * CFG.EMIT_SPREAD_MS);
    return delay;
  };

  test('samma TIME återkommer aldrig som ny position efter dedup-TTL eller två timmar', async () => {
    for (const minutes of [0, 1, 6, 14, 15, 16, 120]) {
      // eslint-disable-next-line no-await-in-loop
      await receive(START + minutes * 60000, [record(START)]);
    }

    expect(positions()).toHaveLength(1);
    expect(positions()[0].data.fixTs).toBe(START);
    expect(seen()).toHaveLength(2); // Korta cachelivstecken bevaras.
    expect(client.getConnectionStats().lastMessageTime).toBe(positions()[0].at);
    expect(client.getConnectionStats().lastOkResponseAt).toBe(START + 120 * 60000);
    expect(client.isConnected).toBe(true); // Servern svarar fortfarande korrekt.
    expect(client.getConnectionStats().counters.staleFixes).toBe(4);
    expect(logger.log.mock.calls.some((call) => call.join(' ').includes('staleFixes=1'))).toBe(true);
  });

  test('stigande men för gamla TIME-fält räknas inte heller som nya positioner', async () => {
    for (const minutes of [0, 15, 120]) {
      const now = START + minutes * 60000;
      // eslint-disable-next-line no-await-in-loop
      await receive(now, [record(now - CFG.MAX_FIX_AGE_MS - 1000)]);
    }

    expect(positions()).toHaveLength(0);
    expect(seen()).toHaveLength(0);
    expect(client._dedup.size).toBe(0);
    expect(client.getConnectionStats().counters.staleFixes).toBe(3);
  });

  test('exakt maxålder godtas men en sekund över stoppas vid första kontakten', async () => {
    await receive(START, [
      record(START - CFG.MAX_FIX_AGE_MS),
      record(START - CFG.MAX_FIX_AGE_MS - 1000, { MMSI: 265552101 }),
    ]);

    expect(positions().map((event) => event.data.mmsi)).toEqual(['265552100']);
    expect(client.getConnectionStats().counters.staleFixes).toBe(1);
  });

  test('nya färska TIME med identiska koordinater fortsätter komma efter flera timmar', async () => {
    for (const minutes of [0, 15, 120]) {
      const now = START + minutes * 60000;
      // eslint-disable-next-line no-await-in-loop
      await receive(now, [record(now)]);
    }

    expect(positions()).toHaveLength(3);
    expect(positions().map((event) => event.data.fixTs)).toEqual([START, START + 15 * 60000, START + 120 * 60000]);
    expect(events.map((event) => event.type)).toEqual([
      'static-name', 'ais-message', 'static-name', 'ais-message', 'static-name', 'ais-message',
    ]);
    expect(positions().every((event) => event.data.shipName === 'KÖBÅT')).toBe(true);
  });

  test('en fix som blir för gammal under batchspridningen emitteras inte', async () => {
    await receive(START, [
      record(START),
      record(START - CFG.MAX_FIX_AGE_MS, { MMSI: 265552101 }),
    ]);

    expect(positions().map((event) => event.data.mmsi)).toEqual(['265552100']);
    expect(client.getConnectionStats().counters.staleFixes).toBe(1);
  });

  test('ett eventloopstall kan inte göra en gammal väntande batch till färska positioner', async () => {
    client._handleHttpResult({ statusCode: 200, body: envelope([record(START)]) }, 12);
    jest.setSystemTime(START + 15 * 60000);
    await jest.advanceTimersByTimeAsync(1);

    expect(positions()).toHaveLength(0);
    expect(events.filter((event) => event.type === 'static-name')).toHaveLength(0);
    expect(client.getConnectionStats().lastMessageTime).toBeNull();
    expect(client.getConnectionStats().counters.staleFixes).toBe(1);
    expect(client.getConnectionStats().lastOkResponseAt).toBe(START);
  });

  test('gammalt cacheinnehåll ändrar varken pollkadens eller välformade svars hälsa', async () => {
    client._stopped = true;
    const calls = [];
    client._httpGet = jest.fn(async () => {
      calls.push(Date.now());
      return { statusCode: 200, body: envelope([record(START - 120 * 60000)]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(5 * CFG.POLL_INTERVAL_MS);

    expect(calls.length).toBe(6);
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBe(CFG.POLL_INTERVAL_MS);
    expect(positions()).toHaveLength(0);
    expect(client.getConnectionStats().lastOkResponseAt).toBe(calls[calls.length - 1]);
    expect(client.getConnectionStats().counters.netErrors).toBe(0);
    expect(client.getConnectionStats().counters.parseErrors).toBe(0);
    expect(client.isConnected).toBe(true);
  });

  test('both behåller klockkompensation för färska framtidsstämplade hubbfixar', async () => {
    const mux = new AISSourceMultiplexer(logger);
    mux._config = { source: 'both', aishubUsername: 'testuser', apiKey: null };
    const accepted = [];
    mux.on('ais-message', (data) => accepted.push(data));
    client.on('ais-message', (data) => mux._onChildMessage('aishub', data));
    try {
      // Tre fartyg med samma +180 s-offset: fusionen kan belägga och rätta
      // klockskeven. Ingressen får inte ersätta detta med en snävare policy.
      await receive(START, [0, 1, 2].map((n) => record(START + 180000, { MMSI: 265552100 + n })));
      expect(accepted.length).toBeGreaterThan(0);
      expect(mux.getConnectionStats().fusion.hubClockOffsetMs).toBeLessThan(0);
      expect(accepted.every((data) => data.fixTs <= START + CFG.SEEN_MAX_FUTURE_SKEW_MS)).toBe(true);
      expect(client.getConnectionStats().counters.accepted).toBe(3);
    } finally {
      mux.disconnect();
    }
  });
});
