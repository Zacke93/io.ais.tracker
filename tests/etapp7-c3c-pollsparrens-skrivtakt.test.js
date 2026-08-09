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

  // OMSKRIVET av P1 (söndagsfältet 2026-08-09). Testet krävde tidigare att
  // reservationen bromsade HELA sitt fönster (`calls.length === 0` efter 10 min)
  // — det var precis det beteendet som gav 637 s blindstart i fält, med en båt
  // 69-111 m från en målbro och bridge_text på "Inga båtar är i närheten".
  // Kravet som testet EGENTLIGEN bar (aldrig en för tidig poll) står kvar och
  // mäts nu direkt mot den verkliga polltiden i stället för mot reservationen.
  test('KALLSTART efter hård krasch: klampad väntan (≤ 61 s + jitter) OCH aldrig en för tidig poll', async () => {
    // Simulera exakt vad en krasch lämnar kvar: en reservation skriven vid en
    // poll för 5 s sedan, alltså 10 min − 5 s in i framtiden.
    const crashPollAt = Date.now() - 5000;
    const store = makeCountingStore({
      [CFG.LAST_POLL_SETTINGS_KEY]: crashPollAt + CFG.LAST_POLL_PERSIST_INTERVAL_MS,
    });
    const calls = makeClient(store);
    const startedAt = Date.now();
    await client.connect('testuser');

    // Ingen poll får ske innan 61s-spärren löpt ut räknat från STARTEN
    // (reservationen säger inget mer än "den verkliga pollen låg före nu").
    await jest.advanceTimersByTimeAsync(CFG.MIN_POLL_SPACING_MS - 1);
    expect(calls.length).toBe(0);

    // …och den ska komma direkt därefter — inte efter reservationens rest.
    await jest.advanceTimersByTimeAsync(CFG.START_JITTER_MAX_MS + 2000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const maxWait = CFG.MIN_POLL_SPACING_MS + CFG.START_JITTER_MAX_MS;
    expect(calls[0] - startedAt).toBeLessThanOrEqual(maxWait);
    // RATE-LIMITEN: mätt mot den VERKLIGA föregående pollen, inte reservationen.
    expect(calls[0] - crashPollAt).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
    // Blindfönstret ligger nu en storleksordning under källdödslarmets 15 min
    // (tidigare tak var reservationen + spärren + jittret = 11 min 16 s).
    expect(maxWait).toBeLessThan(2 * 60 * 1000);
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

/**
 * P1 / KALLSTARTSKLAMPEN (söndagsfältet 2026-08-09).
 *
 * Fältet: appen startade 09:23:03.429 och loggade "första poll om 637.2s".
 * Föregående process hade pollat 09:22:37.977 och lämnat efter sig C3c-
 * RESERVATIONEN 09:32:37.977 (pollAt + 10 min). connect() läste den rakt av
 * som "senaste poll" ⇒ sinceLast = −574,5 s ⇒ spacingLeft = 635,5 s. Appen var
 * blind i 10 min 38 s medan KARUKERA gick 111 m → 69 m från Stridsbergsbron och
 * bridge_text stod på "Inga båtar är i närheten av Klaffbron eller
 * Stridsbergsbron".
 *
 * Fixen klampar startfördröjningen till MIN_POLL_SPACING_MS + jitter och
 * adopterar den framtida posten så att grinden i _poll() inte återinför
 * väntan. Testerna nedan mäter BÅDA sidorna av kontraktet: appen får aldrig
 * vara blind längre än 76 s vid start, och den får aldrig polla tätare än 61 s
 * efter den VERKLIGA föregående pollen.
 */
describe('Etapp 7 / P1: kallstartsklampen', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:23:03.429Z')); // fältets starttid
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministisk jitter (0)
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** @returns {{calls:number[], logger:object}} */
  function makeClient(store) {
    const logger = makeLogger();
    client = new AISHubClient(logger, store);
    const calls = [];
    client._httpGet = jest.fn(async () => {
      calls.push(Date.now());
      return { statusCode: 200, body: okSweepBody([]) };
    });
    return { calls, logger };
  }

  /** Loggradens "första poll om X s" som millisekunder. */
  function loggedStartDelayMs(logger) {
    const line = logger.log.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('första poll om'));
    expect(line).toBeDefined();
    return Math.round(parseFloat(line.match(/första poll om ([\d.]+)s/)[1]) * 1000);
  }

  test('(a) RESERVATION LÅNGT I FRAMTIDEN (fältets exakta tal): 637,2 s blir ≤ 61 s + jitter', async () => {
    // Fältets siffror: föregående process pollade 25,452 s före omstarten.
    const fieldPollAt = Date.now() - 25452;
    const store = makeCountingStore({
      [CFG.LAST_POLL_SETTINGS_KEY]: fieldPollAt + CFG.LAST_POLL_PERSIST_INTERVAL_MS,
    });
    const { calls, logger } = makeClient(store);
    const startedAt = Date.now();
    await client.connect('testuser');

    // Loggen får inte längre annonsera 637 s.
    const delay = loggedStartDelayMs(logger);
    expect(delay).toBeLessThanOrEqual(CFG.MIN_POLL_SPACING_MS + CFG.START_JITTER_MAX_MS);
    expect(delay).toBe(CFG.MIN_POLL_SPACING_MS); // jitter mockat till 0

    // Och verkligheten måste följa loggen — inte bara timern i connect():
    // grinden i _poll() läser spärren en gång till och hade utan adoptionen
    // bokat om sig till reservationens hela rest (fixens verkliga fälla).
    await jest.advanceTimersByTimeAsync(CFG.MIN_POLL_SPACING_MS + CFG.START_JITTER_MAX_MS + 1000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0] - startedAt).toBeLessThanOrEqual(CFG.MIN_POLL_SPACING_MS + CFG.START_JITTER_MAX_MS);
    // RATE-LIMITEN mot den VERKLIGA föregående pollen (86,5 s i fältets fall).
    expect(calls[0] - fieldPollAt).toBeGreaterThanOrEqual(CFG.MIN_POLL_SPACING_MS);
  });

  test('(a2) VÄRSTA FALLET — omstart i samma millisekund som föregående poll: spacingen blir exakt 61 s', async () => {
    // Härledningens undre gräns: now − pollAt = 0 ⇒ verklig spacing = 0 + 61 s.
    // Går klampen ens en millisekund lägre är rate-limiten bruten.
    const pollAt = Date.now();
    const store = makeCountingStore({
      [CFG.LAST_POLL_SETTINGS_KEY]: pollAt + CFG.LAST_POLL_PERSIST_INTERVAL_MS,
    });
    const { calls } = makeClient(store);
    await client.connect('testuser');

    await jest.advanceTimersByTimeAsync(CFG.MIN_POLL_SPACING_MS - 1);
    expect(calls.length).toBe(0);
    await jest.advanceTimersByTimeAsync(2);
    expect(calls.length).toBe(1);
    expect(calls[0] - pollAt).toBe(CFG.MIN_POLL_SPACING_MS);
  });

  test('(a3) GRINDEN SLÄPPER SEDAN LÖPANDE: kadensen är bas (65 s) genom hela den gamla reservationens fönster', async () => {
    // Regressionsvakt: en klamp som bara ändrar den FÖRSTA timern men lämnar
    // reservationen i kraft hade gett 1 poll och sedan tystnad i 10 minuter.
    const pollAt = Date.now() - 25452;
    const store = makeCountingStore({
      [CFG.LAST_POLL_SETTINGS_KEY]: pollAt + CFG.LAST_POLL_PERSIST_INTERVAL_MS,
    });
    const { calls } = makeClient(store);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(CFG.LAST_POLL_PERSIST_INTERVAL_MS);

    // 10 min − 61 s startspärr ⇒ ~9 pollar à 65 s.
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBe(CFG.POLL_INTERVAL_MS);
    }
  });

  test('(b) FÄRSK EXAKT STÄMPEL (graciöst stopp): klampen är no-op — kvarvarande ~56 s väntas ut', async () => {
    // disconnect()-vägen skriver den sanna polltiden. Då är spacingLeft ≤ 61 s
    // redan och Math.min får inte ändra någonting.
    const store = makeCountingStore({ [CFG.LAST_POLL_SETTINGS_KEY]: Date.now() - 5000 });
    const { calls, logger } = makeClient(store);
    await client.connect('testuser');
    expect(loggedStartDelayMs(logger)).toBe(CFG.MIN_POLL_SPACING_MS - 5000); // 56 000 ms

    await jest.advanceTimersByTimeAsync(CFG.MIN_POLL_SPACING_MS - 5000 - 1);
    expect(calls.length).toBe(0); // spärren biter fortfarande
    await jest.advanceTimersByTimeAsync(2);
    expect(calls.length).toBe(1);
  });

  test('(c) INGEN LAGRAD STÄMPEL (första installationen): nära noll + jitter', async () => {
    const store = makeCountingStore();
    const { calls, logger } = makeClient(store);
    await client.connect('testuser');
    expect(loggedStartDelayMs(logger)).toBe(0); // jitter mockat till 0

    await jest.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(1);

    // …och med verkligt jitter ligger den kvar under START_JITTER_MAX_MS.
    client.disconnect();
    Math.random.mockReturnValue(0.9); // 0,9 × 15 000 = 13 500 ms
    const store2 = makeCountingStore();
    const { calls: calls2, logger: logger2 } = makeClient(store2);
    await client.connect('testuser');
    expect(loggedStartDelayMs(logger2)).toBe(13500);
    await jest.advanceTimersByTimeAsync(CFG.START_JITTER_MAX_MS);
    expect(calls2.length).toBe(1);
  });

  test('INVARIANTEN ÖVERLEVER KLAMPEN: lagrat värde ≥ varje verklig polltid, även när den första pollen korsar den gamla reservationen', async () => {
    // Omstart 9 min 30 s efter kraschpollen ⇒ första pollen (nu + 61 s) landar
    // EFTER den gamla reservationen ⇒ nyckeln måste skrivas om direkt, annars
    // hade en ny omstart i det läget kunnat polla för tidigt (C3c-invarianten).
    const crashPollAt = Date.now() - (9 * 60 + 30) * 1000;
    const store = makeCountingStore({
      [CFG.LAST_POLL_SETTINGS_KEY]: crashPollAt + CFG.LAST_POLL_PERSIST_INTERVAL_MS,
    });
    const logger = makeLogger();
    client = new AISHubClient(logger, store);
    const probes = [];
    client._httpGet = jest.fn(async () => {
      probes.push({ at: Date.now(), stored: store.get(CFG.LAST_POLL_SETTINGS_KEY) });
      return { statusCode: 200, body: okSweepBody([]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(probes.length).toBeGreaterThan(50);
    for (const p of probes) {
      expect(typeof p.stored).toBe('number');
      expect(p.stored).toBeGreaterThanOrEqual(p.at);
    }
    // Klampen får inte heller öka flash-slitaget: reservationen adopteras, så
    // skrivtakten under timmen är oförändrat en per effektivt fönster (650 s).
    const writes = store.writes.filter((w) => w.k === CFG.LAST_POLL_SETTINGS_KEY);
    expect(writes.length).toBeLessThanOrEqual(Math.ceil((60 * 60 * 1000) / 650000) + 1);
  });
});
