'use strict';

/**
 * PAKET P9 — KAJLIGGARLIVSCYKELN (söndagsfältet 2026-08-09, fynd BX-1/BX-2/BX-4)
 *
 * FÄLTBEVISET: tre SÄNDANDE kajliggare (VIRGO/265552100, CAPELLA/265552060,
 * ELFKUNGEN/265573130) låg i 21 av 21 AISHub-pollsvar under 33 minuter och
 * raderades ändå 20 gånger — 19 återfödelser, 46 % av alla UI-omräkningar.
 * Raderingarna föll på EXAKT mottagning + 120 001 ms, 8/8 för VIRGO: ingen
 * spridning alls. Rotorsaken är ett kontraktsbrott mot AIS självt —
 * FAR_DISTANCE (120 s) understiger klass B:s stillaliggarkadens (180 s,
 * verifierad ur AISHubs egna TIME-fält: 09:32:20 / 09:35:21 / 09:38:20 …).
 *
 * Tre oberoende åtgärder, alla tre nödvändiga:
 *  (a) LIVSTECKNET  — en dedupad post med FÄRSK fix bevisar att källan
 *      fortfarande rapporterar ett sändande fartyg (AISHubClient → mux → app).
 *  (b) FÖRTÖJNINGSGRENEN — calculateProximityTimeout läser _moored och den
 *      inlärda kajkartan (BX-4: filen innehöll NOLL förekomster av _moored
 *      trots att ⚓ [MOORED] loggades 6 ms före ⏱️ [PROXIMITY_TIMEOUT]).
 *  (c) GRAVVÅRDEN   — beteendeackumulatorerna överlever en kortvarig
 *      felaktig radering, så 2h-backstoppen blir NÅBAR igen (BX-2).
 */

const AISHubClient = require('../lib/connection/AISHubClient');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const ProximityService = require('../lib/services/ProximityService');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const {
  AIS_CONFIG, TIMEOUT_SETTINGS, VESSEL_GRAVE, MOORING_DETECTION,
} = require('../lib/constants');

const HUB = AIS_CONFIG.AISHUB;

function makeLogger() {
  return {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
}

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
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

/** TIME-fält i AISHubs HUMAN-format för ett givet epoch-ms. */
function timeField(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}

/** VIRGO-liknande kajliggare: 0 kn, ~750 m från närmaste bro. */
function quayRecord(fixMs, overrides = {}) {
  return {
    MMSI: 265552100,
    TIME: timeField(fixMs),
    LATITUDE: 58.2790,
    LONGITUDE: 12.2790,
    COG: 0,
    SOG: 0,
    NAVSTAT: 5,
    NAME: 'VIRGO',
    ...overrides,
  };
}

// ===========================================================================
// (a) AISHUB-LIVSTECKNET (BX-1)
// ===========================================================================
describe('P9(a): dedupad post med FÄRSK fix är ett livstecken', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministisk jitter
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function collect(client_) {
    const events = [];
    for (const type of ['ais-message', 'vessel:seen']) {
      client_.on(type, (payload) => events.push({ type, payload }));
    }
    return events;
  }

  test('KÄRNAN: samma fix i poll 2 ⇒ INGEN ais-message men ETT vessel:seen', async () => {
    // Fixen är 20 s gammal vid första pollen — långt inom färskhetsgränsen
    // även när nästa poll kommer 65 s senare (85 s < 365 s).
    const fixMs = Date.now() - 20 * 1000;
    client = new AISHubClient(makeLogger(), makeStore());
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body: okSweepBody([quayRecord(fixMs)]) }));
    const events = collect(client);

    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(5 * 1000);
    expect(events.filter((e) => e.type === 'ais-message')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'vessel:seen')).toHaveLength(0);

    // Poll 2: identisk post (AISHub levererar samma fix tills fartyget sänder
    // på nytt) — dedupas, men ska nu ge livstecken.
    await jest.advanceTimersByTimeAsync(70 * 1000);
    const seen = events.filter((e) => e.type === 'vessel:seen');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload.mmsi).toBe('265552100');
    expect(seen[0].payload.fixTs).toBe(fixMs);
    // Livstecknet får ALDRIG bära data som kan förväxlas med en fix.
    expect(Object.keys(seen[0].payload).sort()).toEqual(['fixTs', 'mmsi']);
    expect(events.filter((e) => e.type === 'ais-message')).toHaveLength(1);
  });

  test('AISHubs CACHE av ett dött fartyg ger INGET livstecken (gammal fix)', async () => {
    // 400 s gammal fix: bortom SEEN_MAX_FIX_AGE_MS (365 s) men innanför
    // dedup-kartans TTL (MAX_FIX_AGE_MS + 60 s), så posten dedupas verkligen.
    const fixMs = Date.now() - 400 * 1000;
    client = new AISHubClient(makeLogger(), makeStore());
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body: okSweepBody([quayRecord(fixMs)]) }));
    const events = collect(client);

    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(5 * 1000);
    await jest.advanceTimersByTimeAsync(70 * 1000);

    // Poll 1 accepterade fixen (klienten har ingen egen åldersgrind — den bor
    // i fusionen), poll 2 dedupade den. INGET livstecken i något av stegen.
    expect(events.filter((e) => e.type === 'ais-message')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'vessel:seen')).toHaveLength(0);
    const pollLines = client.logger.log.mock.calls
      .map((c) => c.join(' ')).filter((l) => l.includes('[AISHUB_POLL]'));
    expect(pollLines[1]).toContain('dupes=1');
    expect(pollLines[1]).toContain('seen=0');
  });

  test('GRÄNSEN: livstecknet UPPHÖR när fixen åldrats förbi 365 s', async () => {
    const fixMs = Date.now();
    client = new AISHubClient(makeLogger(), makeStore());
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body: okSweepBody([quayRecord(fixMs)]) }));

    await client.connect('testuser');
    // Kör förbi gränsen men UNDER dedup-TTL:n (780 s) så posten fortsätter
    // dedupas hela vägen — det enda som ändras är livstecknet.
    await jest.advanceTimersByTimeAsync(HUB.SEEN_MAX_FIX_AGE_MS + 3 * HUB.POLL_INTERVAL_MS);

    const flags = client.logger.log.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('[AISHUB_POLL]'))
      .slice(1) // poll 1 accepterade fixen
      .map((l) => {
        expect(l).toContain('dupes=1'); // posten ligger kvar i varje svep
        return l.includes('seen=1');
      });
    expect(flags).toContain(true);
    expect(flags).toContain(false);
    // Monotont: alla livstecken kommer FÖRE tystnaden — aldrig tvärtom.
    expect(flags.indexOf(false)).toBeGreaterThan(flags.lastIndexOf(true));
  });

  test('framtida skräpklocka räknas INTE som livstecken (absolutbeloppet)', async () => {
    const client1 = new AISHubClient(makeLogger(), makeStore());
    client = client1;
    // Två poster med samma mmsi i SAMMA svep: den andra har äldre fixTs och
    // dedupas därför direkt. Vi sätter den första långt fram i tiden så att
    // dedup-posten (lastFix) blir framtida och den andra jämförelsen slår.
    const future = Date.now() + 30 * 60 * 1000;
    client._httpGet = jest.fn(async () => ({
      statusCode: 200,
      body: okSweepBody([quayRecord(future), quayRecord(future)]),
    }));
    const events = collect(client);
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(5 * 1000);
    expect(events.filter((e) => e.type === 'vessel:seen')).toHaveLength(0);
  });

  test('telemetri: AISHUB_POLL bär seen= vid sidan av dupes=', async () => {
    const fixMs = Date.now() - 10 * 1000;
    client = new AISHubClient(makeLogger(), makeStore());
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body: okSweepBody([quayRecord(fixMs)]) }));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(70 * 1000);
    const pollLines = client.logger.log.mock.calls
      .map((c) => c.join(' ')).filter((l) => l.includes('[AISHUB_POLL]'));
    expect(pollLines[0]).toContain('dupes=0');
    expect(pollLines[0]).toContain('seen=0');
    expect(pollLines[1]).toContain('dupes=1');
    expect(pollLines[1]).toContain('seen=1');
    expect(client.getConnectionStats().counters.seen).toBe(1);
  });
});

describe('P9(a): muxens vidarebefordran lyder pipeline-regeln', () => {
  let mux;

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
  });

  function makeMux(source) {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux._config = { source, apiKey: 'k', aishubUsername: 'u' };
    const seen = [];
    mux.on('vessel:seen', (d) => seen.push(d));
    return seen;
  }

  test("'both' och 'aishub' släpper igenom livstecknet", () => {
    let seen = makeMux('both');
    mux._onChildVesselSeen('aishub', { mmsi: 265552100, fixTs: 1 });
    expect(seen).toEqual([{ mmsi: '265552100', fixTs: 1 }]);

    seen = makeMux('aishub');
    mux._onChildVesselSeen('aishub', { mmsi: '265552060', fixTs: 2 });
    expect(seen).toEqual([{ mmsi: '265552060', fixTs: 2 }]);
  });

  test("'shadow' släpper INTE igenom — beviset ska vara rent", () => {
    const seen = makeMux('shadow');
    mux._onChildVesselSeen('aishub', { mmsi: '265552100', fixTs: 1 });
    expect(seen).toHaveLength(0);
  });

  test('trasig nyttolast tystas (ingen mmsi / ingen fixTs)', () => {
    const seen = makeMux('both');
    mux._onChildVesselSeen('aishub', null);
    mux._onChildVesselSeen('aishub', { fixTs: 1 });
    mux._onChildVesselSeen('aishub', { mmsi: '265552100' });
    mux._onChildVesselSeen('aishub', { mmsi: '265552100', fixTs: 'x' });
    expect(seen).toHaveLength(0);
  });
});

// ===========================================================================
// (a) CHURN-SCENARIOT: 180 s-kadens mot 120 s-timeout
// ===========================================================================
describe('P9(a): churn-scenariot — livstecknet håller kajliggaren vid liv', () => {
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    const logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  function seedQuayVessel(mmsi) {
    const now = Date.now();
    svc.vessels.set(mmsi, {
      mmsi, lat: 58.2790, lon: 12.2790, sog: 0, cog: 0, status: 'en-route', timestamp: now, lastPositionUpdate: now,
    });
    // Exakt fältets villkor: >600 m från bro ⇒ FAR_DISTANCE = 120 s.
    svc.scheduleCleanup(mmsi, TIMEOUT_SETTINGS.FAR_DISTANCE);
  }

  test('180 s-kadens + 120 s-timeout + livstecken var 65:e s ⇒ INGEN removal', () => {
    const mmsi = '265552100';
    seedQuayVessel(mmsi);
    // Åtta pollar à 65 s = 520 s > fyra hela sändarslottar. Utan livstecken
    // hade fartyget raderats fyra gånger på samma sträcka.
    for (let i = 0; i < 8; i++) {
      jest.advanceTimersByTime(65 * 1000);
      expect(svc.noteVesselSeen(mmsi)).toBe(true);
    }
    expect(svc.vessels.has(mmsi)).toBe(true);
  });

  test('ÄKTA TYSTNAD (inga livstecken) ⇒ removal på 120 s som förut', () => {
    const mmsi = '265552100';
    seedQuayVessel(mmsi);
    jest.advanceTimersByTime(TIMEOUT_SETTINGS.FAR_DISTANCE + 10);
    expect(svc.vessels.has(mmsi)).toBe(false);
  });

  test('livstecknet KORTAR aldrig ett längre liv (BUG 6-guarden intakt)', () => {
    const mmsi = '265552100';
    const now = Date.now();
    svc.vessels.set(mmsi, {
      mmsi, lat: 58.2790, lon: 12.2790, sog: 0, status: 'en-route', timestamp: now, lastPositionUpdate: now,
    });
    svc.scheduleCleanup(mmsi, TIMEOUT_SETTINGS.FAR_DISTANCE); // 2 min
    svc.scheduleCleanup(mmsi, TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN); // 30 min vinner
    jest.advanceTimersByTime(60 * 1000);
    svc.noteVesselSeen(mmsi); // laddar om 30 min — inte 2 min
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(svc.vessels.has(mmsi)).toBe(true);
  });

  test('livstecken för OKÄNT mmsi återupplivar ingenting', () => {
    expect(svc.noteVesselSeen('999999999')).toBe(false);
    expect(svc.vessels.has('999999999')).toBe(false);
  });

  test('livstecknet rör INTE vessel.timestamp (klockdomän M) — bara _lastSeen', () => {
    const mmsi = '265552100';
    seedQuayVessel(mmsi);
    const v = svc.vessels.get(mmsi);
    const stamp = v.timestamp;
    const posStamp = v.lastPositionUpdate;
    jest.advanceTimersByTime(60 * 1000);
    svc.noteVesselSeen(mmsi);
    expect(v.timestamp).toBe(stamp);
    expect(v.lastPositionUpdate).toBe(posStamp);
    expect(v._lastSeen).toBe(Date.now());
    // Position/status/ETA orörda.
    expect(v.lat).toBe(58.2790);
    expect(v.status).toBe('en-route');
  });

  test('en resa som redan eliminerats kan inte hållas vid liv av källans cache', () => {
    const mmsi = '265552100';
    seedQuayVessel(mmsi);
    svc._eliminationPending = new Set([mmsi]);
    expect(svc.noteVesselSeen(mmsi)).toBe(false);
  });
});

// ===========================================================================
// (a) HELA KEDJAN: AISHubClient → mux → app-handler → VesselDataService
// ===========================================================================
describe('P9(a): fältfallet end-to-end (klient → mux → livsklocka)', () => {
  let client;
  let mux;
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
    client = new AISHubClient(makeLogger(), makeStore());
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux._hubClient = client;
  });

  afterEach(() => {
    svc.clearAllTimers();
    client.disconnect();
    mux.removeAllListeners();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Kajliggaren i fältet: 0 kn, >600 m från bro ⇒ FAR_DISTANCE. */
  function seedVessel(mmsi) {
    const now = Date.now();
    svc.vessels.set(mmsi, {
      mmsi, lat: 58.2790, lon: 12.2790, sog: 0, cog: 0, status: 'en-route', timestamp: now, lastPositionUpdate: now,
    });
    svc.scheduleCleanup(mmsi, TIMEOUT_SETTINGS.FAR_DISTANCE);
  }

  async function runPolls(ms, { withSeenHandler }) {
    mux._config = { source: 'both', apiKey: 'k', aishubUsername: 'u' };
    mux._bindHubChild(); // den RIKTIGA wiringen — inte en handskriven spegel
    // Appens ordinarie väg: varje ACCEPTERAD fix schemalägger om cleanupen
    // (app._analyzeVesselPosition steg 7). Den finns i båda armarna nedan —
    // det enda som skiljer dem är livstecknet.
    mux.on('ais-message', (m) => {
      if (svc.vessels.has(String(m.mmsi))) {
        svc.scheduleCleanup(String(m.mmsi), TIMEOUT_SETTINGS.FAR_DISTANCE);
      }
    });
    if (withSeenHandler) {
      // App-handlerns kontrakt (app._onVesselSeen).
      mux.on('vessel:seen', (d) => svc.noteVesselSeen(String(d.mmsi)));
    }
    // Sändaren håller klass B-kadensen: NY fix var 180:e sekund, samma fix
    // i mellanliggande pollar (exakt AISHubs beteende i fältet).
    const t0 = Date.now();
    client._httpGet = jest.fn(async () => {
      const slot = Math.floor((Date.now() - t0) / (180 * 1000));
      return { statusCode: 200, body: okSweepBody([quayRecord(t0 + slot * 180 * 1000)]) };
    });
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(ms);
  }

  test('MED livstecken: kajliggaren överlever 9 minuter trots 120 s-timeout', async () => {
    const mmsi = '265552100';
    seedVessel(mmsi);
    await runPolls(9 * 60 * 1000, { withSeenHandler: true });
    expect(svc.vessels.has(mmsi)).toBe(true);
    expect(client.getConnectionStats().counters.seen).toBeGreaterThan(0);
  });

  test('UTAN livstecken (förfixläget): SAMMA data raderar fartyget — fältets bugg', async () => {
    const mmsi = '265552100';
    seedVessel(mmsi);
    await runPolls(9 * 60 * 1000, { withSeenHandler: false });
    expect(svc.vessels.has(mmsi)).toBe(false);
  });
});

// ===========================================================================
// (b) FÖRTÖJNINGSGRENEN I TIMEOUTEN (BX-4)
// ===========================================================================
describe('P9(b): calculateProximityTimeout läser förtöjningen', () => {
  const FAR = { nearestDistance: 921 }; // ELFKUNGENs uppmätta avstånd

  function makeProx(appExtras = null) {
    const logger = makeLogger();
    const app = appExtras ? Object.assign(logger, appExtras) : logger;
    return new ProximityService(new BridgeRegistry(), app);
  }

  test('KONTRAKTET: ett fartyg klassat som _moored får ALDRIG FAR_DISTANCE', () => {
    const prox = makeProx();
    const t = prox.calculateProximityTimeout({
      mmsi: '265552100', sog: 0, status: 'en-route', _moored: true, lat: 58.2790, lon: 12.2790,
    }, FAR);
    expect(t).toBe(TIMEOUT_SETTINGS.MOORED_VESSEL_MIN);
    expect(t).toBeGreaterThan(TIMEOUT_SETTINGS.FAR_DISTANCE);
    // Livslängden måste överstiga klass B:s stillaliggarkadens med marginal.
    expect(t).toBeGreaterThanOrEqual(3 * 180 * 1000);
  });

  test('REGRESSIONSVAKT: omoorad båt >600 m behåller FAR_DISTANCE (2 min)', () => {
    const prox = makeProx();
    const t = prox.calculateProximityTimeout({
      mmsi: '111', sog: 6, status: 'en-route', lat: 58.2790, lon: 12.2790,
    }, FAR);
    expect(t).toBe(TIMEOUT_SETTINGS.FAST_VESSEL_MIN); // sog>4 ⇒ 5 min-grenen
    const slow = prox.calculateProximityTimeout({
      mmsi: '111', sog: 0.2, status: 'en-route', lat: 58.2790, lon: 12.2790,
    }, FAR);
    expect(slow).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
  });

  test('INLÄRD KAJPLATS: stillaliggare på inlärd plats får förtöjningslivslängd', () => {
    const prox = makeProx({ _isNearLearnedMooringSpot: (lat, lon, r) => r === 100 });
    const t = prox.calculateProximityTimeout({
      mmsi: '265573130', sog: null, status: 'en-route', lat: 58.26622, lon: 12.26541,
    }, FAR);
    expect(t).toBe(TIMEOUT_SETTINGS.MOORED_VESSEL_MIN);
  });

  test('INLÄRD KAJPLATS: en båt i FART på samma punkt är på genomresa', () => {
    const prox = makeProx({ _isNearLearnedMooringSpot: () => true });
    const t = prox.calculateProximityTimeout({
      mmsi: '265573130', sog: 3.0, status: 'en-route', lat: 58.26622, lon: 12.26541,
    }, FAR);
    expect(t).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
  });

  test('grenen kan bara FÖRLÄNGA — aktiv resa (30 min) vinner över 10 min', () => {
    const prox = makeProx();
    const t = prox.calculateProximityTimeout({
      mmsi: '265552100', sog: 0, status: 'en-route', _moored: true, targetBridge: 'Klaffbron', lat: 58.2790, lon: 12.2790,
    }, FAR);
    expect(t).toBe(TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
  });

  test('kajkartan får aldrig fälla beräkningen (kastande app-metod)', () => {
    const prox = makeProx({
      _isNearLearnedMooringSpot: () => {
        throw new Error('karta trasig');
      },
    });
    const t = prox.calculateProximityTimeout({
      mmsi: '1', sog: 0, status: 'en-route', lat: 58.2790, lon: 12.2790,
    }, FAR);
    expect(t).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
  });

  test('BX-4 SAMMA TICK: ⚓ [MOORED] och ⏱️ [PROXIMITY_TIMEOUT] kan inte längre motsäga varandra', () => {
    // Fältet: rad 330 loggade MOORED 09:33:41.466 och rad 349 loggade
    // timeout=2.0min 09:33:41.472 för SAMMA fartyg — 6 ms isär.
    const logger = makeLogger();
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    const prox = new ProximityService(new BridgeRegistry(), logger);
    const vessel = {
      mmsi: '265552100',
      lat: 58.2790,
      lon: 12.2790,
      sog: 0,
      status: 'en-route',
      navStatus: 5,
      _stationarySince: Date.now() - 60 * 1000,
      _firstSeenLat: 58.2790,
      _firstSeenLon: 12.2790,
    };
    svc._updateMooringEvidence(vessel, 0);
    expect(vessel._moored).toBe(true); // navstatus-lagret fyrar
    const t = prox.calculateProximityTimeout(vessel, FAR);
    expect(t).not.toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
    svc.clearAllTimers();
  });
});

// ===========================================================================
// (c) GRAVVÅRDEN (BX-2)
// ===========================================================================
describe('P9(c): gravvården — beteendebevis över en kortvarig radering', () => {
  let svc;
  let logger;
  const POS = { lat: 58.26622, lon: 12.26541 }; // ELFKUNGENs position

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null,
    };
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  /** Lägger in ett fartyg med färdiga ackumulatorer och timeout-raderar det. */
  function seedAndRemove(mmsi, overrides = {}) {
    const stationarySince = Date.now() - 40 * 60 * 1000; // 40 min stillhet
    svc.vessels.set(mmsi, {
      mmsi,
      lat: POS.lat,
      lon: POS.lon,
      sog: 0,
      cog: 0,
      status: 'en-route',
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
      passedBridges: ['Olidebron'],
      passedAt: { Olidebron: Date.now() - 60 * 60 * 1000 },
      _stationarySince: stationarySince,
      _moored: true,
      _hasMovementProof: true,
      _hasCorroboratedMovement: true,
      _firstSeenLat: 58.2600,
      _firstSeenLon: 12.2600,
      _trackingEpisodeStartTs: stationarySince,
      ...overrides,
    });
    svc.removeVessel(mmsi, 'timeout');
    return stationarySince;
  }

  test('KÄRNAN: återfödelse PÅ PLATS ärver stillhetsklockan och förtöjningen', () => {
    const mmsi = '265573130';
    const stationarySince = seedAndRemove(mmsi);
    expect(svc.vessels.has(mmsi)).toBe(false);
    expect(svc._vesselGraves.has(mmsi)).toBe(true);

    jest.advanceTimersByTime(3 * 60 * 1000); // återföds 3 min senare
    const reborn = svc._createVesselObject(mmsi, {
      lat: POS.lat + 0.0002, lon: POS.lon, sog: 0, cog: 0,
    }, undefined);

    expect(reborn._stationarySince).toBe(stationarySince);
    expect(reborn._moored).toBe(true);
    expect(reborn._hasMovementProof).toBe(true);
    expect(reborn._hasCorroboratedMovement).toBe(true);
    expect(reborn._firstSeenLat).toBe(58.2600);
    expect(reborn._firstSeenLon).toBe(12.2600);
    expect(reborn._trackingEpisodeStartTs).toBe(stationarySince);
    // Graven konsumeras — en grav får inte överleva sin egen båt.
    expect(svc._vesselGraves.has(mmsi)).toBe(false);
  });

  test('2h-BACKSTOPPEN ÄR NÅBAR IGEN (BX-2:s kärnpåstående)', () => {
    const mmsi = '265573130';
    // Utan grav: ett sampel per liv ⇒ Date.now() − _stationarySince ≡ 0.
    // Med grav: klockan går vidare över raderingarna.
    const start = Date.now() - (MOORING_DETECTION.MAX_STATIONARY_WAIT_MS + 60 * 1000);
    seedAndRemove(mmsi, {
      _stationarySince: start,
      _moored: false, // ingen navstatus, ingen zon — backstoppen är enda vägen
      navStatus: null,
      _trackingEpisodeStartTs: start,
    });
    jest.advanceTimersByTime(60 * 1000);
    const reborn = svc._createVesselObject(mmsi, {
      lat: POS.lat, lon: POS.lon, sog: 0, cog: 0,
    }, undefined);
    expect(reborn._stationarySince).toBe(start);
    // Kör den RIKTIGA klassningen: backstoppen ska fyra.
    svc._updateMooringEvidence(reborn, 0);
    expect(reborn._moored).toBe(true);
    expect(logger.log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('backstop'))).toBe(true);
  });

  test('ÅTERFÖDD LÅNGT BORT ärver ingenting (äkta transitör)', () => {
    const mmsi = '265573130';
    seedAndRemove(mmsi);
    jest.advanceTimersByTime(60 * 1000);
    // 500 m norrut — bortom kajvobbelvaktens 200 m.
    const reborn = svc._createVesselObject(mmsi, {
      lat: POS.lat + 500 / 111320, lon: POS.lon, sog: 5, cog: 20,
    }, undefined);
    expect(reborn._stationarySince).toBeNull();
    expect(reborn._moored).toBe(false);
    expect(reborn._hasMovementProof).toBe(false);
    expect(reborn._firstSeenLat).toBeCloseTo(POS.lat + 500 / 111320, 6);
  });

  test('GRAVEN GÅR UT (TTL) — efter 15 min byggs fartyget från noll', () => {
    const mmsi = '265573130';
    seedAndRemove(mmsi);
    jest.advanceTimersByTime(VESSEL_GRAVE.TTL_MS + 1000);
    const reborn = svc._createVesselObject(mmsi, {
      lat: POS.lat, lon: POS.lon, sog: 0, cog: 0,
    }, undefined);
    expect(reborn._stationarySince).toBeNull();
    expect(reborn._moored).toBe(false);
    expect(svc._vesselGraves.size).toBe(0);
  });

  test('FULLBORDAD RESA gravläggs INTE — den ska börja om från noll', () => {
    const mmsi = '265573130';
    svc.vessels.set(mmsi, {
      mmsi,
      lat: POS.lat,
      lon: POS.lon,
      sog: 0,
      status: 'en-route',
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
      passedBridges: ['Olidebron'],
      _routeDirection: 'south',
      _stationarySince: Date.now() - 60 * 60 * 1000,
      _moored: true,
    });
    svc.removeVessel(mmsi, 'timeout'); // journeyFullyTraversed ⇒ isCompletedTimeout
    expect(svc._vesselGraves.has(mmsi)).toBe(false);

    svc.vessels.set(mmsi, {
      mmsi, lat: POS.lat, lon: POS.lon, sog: 0, status: 'en-route', timestamp: Date.now(), lastPositionUpdate: Date.now(), _moored: true,
    });
    svc.removeVessel(mmsi, 'passed-final-bridge');
    expect(svc._vesselGraves.has(mmsi)).toBe(false);
  });

  test('GRAVEN BÄR INTE journey-tillstånd (passedBridges/status/målbro)', () => {
    const mmsi = '265573130';
    seedAndRemove(mmsi, { targetBridge: 'Klaffbron', status: 'waiting' });
    const grave = svc._vesselGraves.get(mmsi);
    expect(Object.keys(grave.fields).sort()).toEqual([
      '_firstSeenLat', '_firstSeenLon', '_hasCorroboratedMovement', '_hasMovementProof',
      '_moored', '_stationarySince', '_trackingEpisodeStartTs',
    ]);
    // FP9-läxan: passedBridges DELAS by reference. Graven får därför inte
    // hålla någon referens alls till fartygets arrayer/objekt.
    for (const v of Object.values(grave.fields)) {
      expect(typeof v === 'object' && v !== null).toBe(false);
    }
    jest.advanceTimersByTime(60 * 1000);
    const reborn = svc._createVesselObject(mmsi, {
      lat: POS.lat, lon: POS.lon, sog: 0, cog: 0,
    }, undefined);
    expect(reborn.passedBridges).toEqual([]);
    expect(reborn.targetBridge).toBeNull();
    expect(reborn.status).toBe('en-route');
  });

  test('gravens position är immun mot _cleanupVesselState (kopieras FÖRE städning)', () => {
    const mmsi = '265573130';
    seedAndRemove(mmsi);
    const grave = svc._vesselGraves.get(mmsi);
    expect(grave.lat).toBeCloseTo(POS.lat, 6);
    expect(grave.lon).toBeCloseTo(POS.lon, 6);
    expect(Number.isFinite(grave.fields._stationarySince)).toBe(true);
  });

  test('MAX_ENTRIES-taket håller kartan bunden (äldsta graven ryker)', () => {
    for (let i = 0; i < VESSEL_GRAVE.MAX_ENTRIES + 10; i++) {
      const mmsi = `2655${String(i).padStart(5, '0')}`;
      svc.vessels.set(mmsi, {
        mmsi, lat: POS.lat, lon: POS.lon, sog: 0, status: 'en-route', timestamp: Date.now(), lastPositionUpdate: Date.now(),
      });
      svc.removeVessel(mmsi, 'timeout');
      jest.advanceTimersByTime(100); // distinkta gravtider
    }
    expect(svc._vesselGraves.size).toBeLessThanOrEqual(VESSEL_GRAVE.MAX_ENTRIES);
    expect(svc._vesselGraves.has('265500000')).toBe(false); // den ÄLDSTA graven
    expect(svc._vesselGraves.has(`2655${String(VESSEL_GRAVE.MAX_ENTRIES + 9).padStart(5, '0')}`)).toBe(true);
  });

  test('FÄLTLIST-FÄLLAN: de ärvda fälten överlever nästa _createVesselObject', () => {
    const mmsi = '265573130';
    const stationarySince = seedAndRemove(mmsi);
    jest.advanceTimersByTime(60 * 1000);
    const reborn = svc._createVesselObject(mmsi, {
      lat: POS.lat, lon: POS.lon, sog: 0, cog: 0,
    }, undefined);
    // Nästa ordinarie sampel (med oldVessel) får inte tappa arvet.
    const next = svc._createVesselObject(mmsi, {
      lat: POS.lat, lon: POS.lon, sog: 0, cog: 0,
    }, reborn);
    expect(next._stationarySince).toBe(stationarySince);
    expect(next._moored).toBe(true);
    expect(next._hasMovementProof).toBe(true);
    expect(next._hasCorroboratedMovement).toBe(true);
    expect(next._firstSeenLat).toBe(58.2600);
    expect(next._firstSeenLon).toBe(12.2600);
    expect(next._trackingEpisodeStartTs).toBe(stationarySince);
  });

  test('ÄKTA AVGÅNG släpper förtöjningen trots arv (rörelsebevis vinner)', () => {
    const mmsi = '265573130';
    seedAndRemove(mmsi);
    jest.advanceTimersByTime(60 * 1000);
    const reborn = svc._createVesselObject(mmsi, {
      lat: POS.lat, lon: POS.lon, sog: 3.5, cog: 20,
    }, undefined);
    expect(reborn._moored).toBe(true); // ärvt
    svc._updateMooringEvidence(reborn, 3.5); // men samplet visar fart
    expect(reborn._stationarySince).toBeNull();
    expect(reborn._moored).toBe(false);
  });
});

// ===========================================================================
// KEDJAN: (b)+(c) tillsammans stoppar churnen redan vid FÖRSTA återfödelsen
// ===========================================================================
describe('P9: kedjan (c)→(b) stänger churnen utan AISHub', () => {
  test('reborn kajliggare får 10 min i stället för 2 min på sitt FÖRSTA sampel', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T09:33:41.000Z'));
    const logger = makeLogger();
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = { gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null };
    svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
    const prox = new ProximityService(new BridgeRegistry(), logger);
    const mmsi = '265552100';
    const pos = { lat: 58.2790, lon: 12.2790 };

    svc.vessels.set(mmsi, {
      mmsi,
      ...pos,
      sog: 0,
      cog: 0,
      status: 'en-route',
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
      _stationarySince: Date.now() - 30 * 60 * 1000,
      _moored: true,
      _firstSeenLat: pos.lat,
      _firstSeenLon: pos.lon,
    });
    svc.removeVessel(mmsi, 'timeout');

    jest.advanceTimersByTime(180 * 1000); // nästa klass B-slot
    const reborn = svc._createVesselObject(mmsi, { ...pos, sog: 0, cog: 0 }, undefined);
    svc._updateMooringEvidence(reborn, 0);
    const dist = geometry.calculateDistance(pos.lat, pos.lon, 58.284095, 12.283930);
    expect(dist).toBeGreaterThan(600); // fältets geometri: >600 m ⇒ FAR_DISTANCE
    const timeout = prox.calculateProximityTimeout(reborn, { nearestDistance: dist });
    expect(timeout).toBe(TIMEOUT_SETTINGS.MOORED_VESSEL_MIN);
    expect(timeout).toBeGreaterThan(180 * 1000); // > sändarkadensen

    svc.clearAllTimers();
    jest.useRealTimers();
  });
});
