'use strict';

const AISHubClient = require('../lib/connection/AISHubClient');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * Helgranskningen 2026-11-03: om Homeys väggklocka stegas BAKÅT medan appen
 * kör (NTP-korrigering) låg klientens eget minnesankare i framtiden. Väntan
 * till nästa poll blev då lika lång som klocksteget, och inga vakter märkte
 * det eftersom de mäter now − stämpel (negativ). I AISHub-solo var appen blind
 * utan någon signal. Rättelsen ankrar om kadensen när det EGNA ankaret ligger
 * i framtiden; en främmande framtida spärr (annan enhet) gäller som förut.
 */
const CFG = AIS_CONFIG.AISHUB;
const HOUR = 60 * 60 * 1000;

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

function okBody() {
  return JSON.stringify([{
    ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: 0,
  }, []]);
}

describe('AISHubClient: väggklocka som stegas bakåt', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-03T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function makeClient(store = makeStore()) {
    client = new AISHubClient({ log: jest.fn(), debug: jest.fn(), error: jest.fn() }, store);
    const calls = [];
    client._httpGet = jest.fn(async () => {
      calls.push(Date.now());
      return { statusCode: 200, body: okBody() };
    });
    return { calls, store };
  }

  test('två timmars steg bakåt: pollningen fortsätter med ordinarie kadens', async () => {
    const { calls } = makeClient();
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    const before = calls.length;
    expect(before).toBeGreaterThanOrEqual(9);

    jest.setSystemTime(new Date(Date.now() - 2 * HOUR));
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    const after = calls.slice(before);
    expect(after.length).toBeGreaterThanOrEqual(8);
    // Rate-limit-disciplinen består: aldrig < 61 s mellan pollstarter.
    for (let i = 1; i < after.length; i++) {
      expect(after[i] - after[i - 1]).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    }
    expect(client.logger.log.mock.calls.some(([msg]) => String(msg).includes('stegad bakåt'))).toBe(true);
  });

  test('en främmande framtida spärr (annan enhet) respekteras fortfarande', async () => {
    const { calls, store } = makeClient();
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    const before = calls.length;
    // En annan enhet har just reserverat 50 s framåt: ingen poll inom 50 s.
    store.set(CFG.LAST_POLL_SETTINGS_KEY, Date.now() + 50 * 1000);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(calls.length).toBe(before);
  });
});
