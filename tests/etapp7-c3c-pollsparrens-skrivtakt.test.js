'use strict';

const AISHubClient = require('../lib/connection/AISHubClient');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * ETAPP 7 / C3c (2026-08-09): AISHUBS POLLSPÄRR-SKRIVNING.
 *
 * 42h-fältprovet 2026-08-06/07 mätte 2 227 `settings.set` på 41,8 h = 1 278
 * skrivningar/dygn — en poll-spärr som skrevs vid VARJE poll, och den sjunde
 * settings.set-anropsplatsen i appen. Fixen stryper skrivningen till en per
 * `LAST_POLL_PERSIST_INTERVAL_MS` genom att lagra en RESERVATION (polltid +
 * fönstret) i stället för polltiden, plus en exakt stämpel vid graciöst stopp.
 *
 * Den bärande invarianten — och därmed hela V2-C2-kravet — är:
 *   LAGRAT VÄRDE ≥ SENASTE VERKLIGA POLL, alltid.
 * Håller den kan en omstart bara vänta för LÄNGE, aldrig polla för tidigt.
 * Testerna nedan mäter (a) skrivtakten, (b) invarianten, (c) att kadensen i
 * processen är oförändrad, (d) stoppstämpeln, (e) att en FRÄMMANDE spärr
 * fortfarande respekteras.
 *
 * Allt under fake timers — en äkta request vore ett testfel i sig.
 */

const CFG = AIS_CONFIG.AISHUB;

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

/** Settings-mock som RÄKNAR skrivningar — det är hela mätobjektet här. */
function makeCountingStore(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
      writes.push({ k, v, at: Date.now() });
    },
  };
}

function okSweepBody(records = []) {
  return JSON.stringify([
    {
      ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: records.length,
    },
    records,
  ]);
}

describe('Etapp 7 / C3c: poll-spärrens skrivtakt', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministisk jitter (0)
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function makeClient(store) {
    client = new AISHubClient(makeLogger(), store);
    const calls = [];
    client._httpGet = jest.fn(async () => {
      calls.push(Date.now());
      return { statusCode: 200, body: okSweepBody([]) };
    });
    return calls;
  }

  test('SKRIVTAKT: 24 h ger 133 skrivningar i stället för ~1 330 — och pollkadensen är ORÖRD', async () => {
    const store = makeCountingStore();
    const calls = makeClient(store);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(24 * 3600 * 1000);

    // Pollandet ska vara exakt som förut: 24 h / 65 s ≈ 1329 pollar.
    expect(calls.length).toBeGreaterThan(1250);
    expect(calls.length).toBeLessThan(1340);

    const pollLockWrites = store.writes.filter((w) => w.k === CFG.LAST_POLL_SETTINGS_KEY);
    // Reservationen förnyas av den FÖRSTA pollen EFTER att den löpt ut, så den
    // effektiva perioden är ceil(fönster / pollintervall) × pollintervall =
    // 10 × 65 s = 650 s — inte 600 s. 24 h / 650 s = 132,9 ⇒ 133 skrivningar.
    // (Jittret är mockat till 0 här; i drift gör 0-5 s jitter perioden marginellt
    // längre, dvs. talet är ett TAK.)
    const effectivePeriodMs = Math.ceil(CFG.LAST_POLL_PERSIST_INTERVAL_MS / CFG.POLL_INTERVAL_MS)
      * CFG.POLL_INTERVAL_MS;
    expect(pollLockWrites.length).toBe(Math.ceil((24 * 3600 * 1000) / effectivePeriodMs));
    // Fältets utgångsläge var 1 278/dygn — det är den siffran som ska falla.
    expect(pollLockWrites.length).toBeLessThan(200);
    // Mätt mot pollandet: färre än var nionde poll skriver.
    expect(pollLockWrites.length * 9).toBeLessThan(calls.length);
  });

  test('INVARIANT (V2-C2): lagrat värde ligger ALDRIG före en verklig polltidpunkt', async () => {
    const store = makeCountingStore();
    client = new AISHubClient(makeLogger(), store);
    const probes = [];
    client._httpGet = jest.fn(async () => {
      // Läses i samma tick som pollen startade ⇒ "skriven FÖRE requesten".
      probes.push({ at: Date.now(), stored: store.get(CFG.LAST_POLL_SETTINGS_KEY) });
      return { statusCode: 200, body: okSweepBody([]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(3 * 3600 * 1000);

    expect(probes.length).toBeGreaterThan(100);
    for (const p of probes) {
      expect(typeof p.stored).toBe('number');
      // Den bärande invarianten: en omstart efter VILKEN som helst av dessa
      // pollar räknar mot ett värde som är ≥ pollens egen tid.
      expect(p.stored).toBeGreaterThanOrEqual(p.at);
    }
  });

  test('KALLSTART efter hård krasch: reservationen bromsar, den släpper aldrig igenom en för tidig poll', async () => {
    // Simulera exakt vad en krasch lämnar kvar: en reservation skriven vid en
    // poll för 5 s sedan, alltså 10 min − 5 s in i framtiden.
    const crashPollAt = Date.now() - 5000;
    const store = makeCountingStore({
      [CFG.LAST_POLL_SETTINGS_KEY]: crashPollAt + CFG.LAST_POLL_PERSIST_INTERVAL_MS,
    });
    const calls = makeClient(store);
    await client.connect('testuser');

    // Ingen poll får ske innan spärren löpt ut mot RESERVATIONEN.
    await jest.advanceTimersByTimeAsync(CFG.LAST_POLL_PERSIST_INTERVAL_MS);
    expect(calls.length).toBe(0);

    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Väntetiden är bounded: aldrig mer än fönstret + spärren + startjittret.
    const maxWait = CFG.LAST_POLL_PERSIST_INTERVAL_MS
      + CFG.MIN_POLL_SPACING_MS + CFG.START_JITTER_MAX_MS;
    expect(calls[0] - crashPollAt).toBeLessThanOrEqual(maxWait);
    // …och taket måste rymmas under källdödslarmets tystnadsfönster (15 min),
    // annars larmar appen om en död källa som bara väntar på sin egen spärr.
    expect(maxWait).toBeLessThan(15 * 60 * 1000);
  });

  test('GRACIÖST STOPP: disconnect() skriver den EXAKTA polltiden ⇒ omstart utan pessimistisk väntan', async () => {
    const store = makeCountingStore();
    const calls = makeClient(store);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    const lastPoll = calls[calls.length - 1];

    // Före stoppet: en reservation i framtiden.
    expect(store.get(CFG.LAST_POLL_SETTINGS_KEY)).toBeGreaterThan(lastPoll);

    client.disconnect();
    client = null;
    // Efter stoppet: exakt polltid, inte reservation.
    expect(store.get(CFG.LAST_POLL_SETTINGS_KEY)).toBe(lastPoll);

    // …och en ny klient (omstartsfallet) väntar då bara ut 61s-spärren.
    const client2 = new AISHubClient(makeLogger(), store);
    const calls2 = [];
    client2._httpGet = jest.fn(async () => {
      calls2.push(Date.now());
      return { statusCode: 200, body: okSweepBody([]) };
    });
    await client2.connect('testuser');
    await jest.advanceTimersByTimeAsync(CFG.MIN_POLL_SPACING_MS + CFG.START_JITTER_MAX_MS + 1000);
    expect(calls2.length).toBe(1);
    client2.disconnect();
  });

  test('ALDRIG POLLAT: disconnect() skriver ingenting (inget att stämpla)', () => {
    const store = makeCountingStore();
    makeClient(store);
    client.disconnect();
    client = null;
    expect(store.writes.filter((w) => w.k === CFG.LAST_POLL_SETTINGS_KEY)).toHaveLength(0);
  });

  test('FRÄMMANDE SPÄRR respekteras fortfarande — reservationen får inte göra klienten döv', async () => {
    const store = makeCountingStore();
    const calls = makeClient(store);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    expect(calls.length).toBe(2);

    // Någon annan (omstartad granne/klockjustering) skriver en spärr i
    // framtiden. Värdet är INTE vårt eget senast skrivna ⇒ ska bita.
    const foreign = Date.now() + 5 * 60 * 1000;
    store.set(CFG.LAST_POLL_SETTINGS_KEY, foreign);
    const before = calls.length;
    await jest.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(calls.length).toBe(before); // helt spärrad under främmande fönstret

    // …och kedjan lever vidare efteråt (V2-C1: en spärr får aldrig döda den).
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(calls.length).toBeGreaterThan(before);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    }

    // SJÄLVLÄKNING: den främmande skrivningen raderade vår reservation ur
    // nyckeln. Nästa poll måste därför skriva om den DIREKT — annars hade
    // nyckeln stått kvar med ett värde FÖRE senaste verkliga poll under resten
    // av throttlefönstret, och en omstart i det läget kunde polla för tidigt.
    const stored = store.get(CFG.LAST_POLL_SETTINGS_KEY);
    expect(stored).not.toBe(foreign);
    expect(stored).toBeGreaterThanOrEqual(calls[calls.length - 1]);
  });

  test('SVÄLJ-FÄLLAN: en kastande settings.set tystar varken loggen eller nästa försök', async () => {
    const logger = makeLogger();
    const store = makeCountingStore();
    let throwing = true;
    store.set = (k, v) => {
      if (throwing) throw new Error('flash full');
      store.data[k] = v;
      store.writes.push({ k, v, at: Date.now() });
    };
    client = new AISHubClient(logger, store);
    const calls = [];
    client._httpGet = jest.fn(async () => {
      calls.push(Date.now());
      return { statusCode: 200, body: okSweepBody([]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);

    // Felet loggas (aldrig svalt tyst) och pollandet fortsätter.
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Kunde inte persistera poll-spärren'));
    expect(calls.length).toBe(2);

    // När skrivningen börjar fungera igen ska nästa poll skriva DIREKT —
    // en misslyckad skrivning får inte bränna hela throttle-fönstret.
    throwing = false;
    const writesBefore = store.writes.length;
    await jest.advanceTimersByTimeAsync(70 * 1000);
    expect(store.writes.length).toBeGreaterThan(writesBefore);
  });

  test('UTAN settingsStore: in-memory-spärren håller kadensen (ingen krasch, inga skrivningar)', async () => {
    client = new AISHubClient(makeLogger(), null);
    const calls = [];
    client._httpGet = jest.fn(async () => {
      calls.push(Date.now());
      return { statusCode: 200, body: okSweepBody([]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(calls.length).toBeGreaterThan(5);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    }
  });
});
