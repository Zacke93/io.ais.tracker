'use strict';

const fs = require('fs');
const path = require('path');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');

/**
 * Etapp 2 (2026-08-02): AISSourceMultiplexer — kontraktet mot app.js.
 * V1-M1: isConnected MÅSTE vara en levande getter-property (app.js:6746
 * läser propertyn; en metod/undefined stänger tyst av B2-watchdogen).
 * V3-M8: varje this.aisClient.<medlem> som app.js använder måste finnas på
 * muxen (svep över källkoden, samma anda som harness-vakter.test.js).
 */

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

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

function msg(overrides = {}) {
  return {
    mmsi: '265001111',
    msgType: 'PositionReport',
    lat: 58.29,
    lon: 12.29,
    sog: 5,
    cog: 25,
    navStatus: null,
    shipName: 'TESTBAT',
    timestamp: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    ...overrides,
  };
}

describe('Etapp 2: kontraktssvepet — varje this.aisClient.<medlem> i app.js finns på muxen', () => {
  test('alla använda medlemmar existerar (funktion eller property)', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const used = new Set();
    const re = /this\.aisClient\.([A-Za-z_$][\w$]*)/g;
    for (let m = re.exec(appSource); m !== null; m = re.exec(appSource)) {
      used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);

    const mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    try {
      for (const member of used) {
        const exists = member in mux
          || Object.getOwnPropertyDescriptor(AISSourceMultiplexer.prototype, member) !== undefined;
        if (!exists) {
          throw new Error(`app.js använder this.aisClient.${member} men muxen saknar den`);
        }
      }
    } finally {
      mux.disconnect();
    }
  });

  test('V1-M1: isConnected är en GETTER på prototypen — aldrig metod/stats-fält', () => {
    const desc = Object.getOwnPropertyDescriptor(AISSourceMultiplexer.prototype, 'isConnected');
    expect(desc).toBeDefined();
    expect(typeof desc.get).toBe('function');
    const mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    try {
      expect(typeof mux.isConnected).toBe('boolean'); // levande värde, inte funktion
    } finally {
      mux.disconnect();
    }
  });
});

describe('Etapp 2: pass-through-defaulten (aisstream) — noll grindar, noll timers', () => {
  let mux;

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
  });

  test('aisstream-meddelanden re-emittas oförändrade (utom namnnormalisering)', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const received = [];
    mux.on('ais-message', (e) => received.push(e));
    const original = msg();
    mux._ingestFromFeed('aisstream', original);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(original); // 'TESTBAT' är redan normaliserat
  });

  test('inga timers och inget fusionsstate i pass-through', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux._ingestFromFeed('aisstream', msg());
    expect(mux._shadowTimer).toBeNull();
    expect(mux._fusionStates.size).toBe(0);
    expect(mux._hubClient).toBeNull();
  });

  test('getConnectionStats: perFeed finns alltid och dedupSize är ett TAL (soak-kravet)', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const stats = mux.getConnectionStats();
    expect(stats.perFeed.aisstream.configured).toBe(false);
    expect(stats.perFeed.aishub.configured).toBe(false);
    expect(typeof stats.perFeed.aishub.dedupSize).toBe('number');
    expect(typeof stats.fusion.stateSize).toBe('number');
    expect(stats.isConnected).toBe(false);
  });
});

describe('Etapp 2: namnnormalisering (V1-m5) — båda källorna, sentinelen bevaras', () => {
  let mux;

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
  });

  test.each([
    ['  VALEN  ', 'VALEN'],
    ['valen', 'VALEN'],
    ['VA  LEN', 'VA LEN'],
    ['VALEN@@@', 'VALEN'],
    ['@@@', 'Unknown'],
    ['', 'Unknown'],
    [null, 'Unknown'],
    ['Unknown', 'Unknown'], // literalen får ALDRIG versaliseras — appens grindar
  ])('_normalizeName(%p) → %p', (raw, expected) => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    expect(mux._normalizeName(raw)).toBe(expected);
  });

  test('static-name normaliseras och Unknown-namn undertrycks', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const names = [];
    mux.on('static-name', (e) => names.push(e));
    mux._onChildStaticName('aisstream', { mmsi: '1', shipName: '  valen ' });
    mux._onChildStaticName('aisstream', { mmsi: '2', shipName: '@@@' });
    expect(names).toEqual([{ mmsi: '1', shipName: 'VALEN' }]);
  });
});

describe('Etapp 2: skuggläget — inte en enda AISHub-fix vidare till pipelinen', () => {
  let mux;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    logger = makeLogger();
    // apiKey null ⇒ stream-barnet startas ALDRIG (ingen ws-anslutning i test);
    // username satt ⇒ hub-barnet skapas men första pollen ligger 61s+ bort
    // under fake timers som vi inte advancerar till.
    mux = new AISSourceMultiplexer(logger, makeStore());
    mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'testuser' });
  });

  afterEach(() => {
    mux.disconnect();
    mux = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('aishub-meddelanden stoppas; aisstream passerar; static-name från aishub undertrycks', () => {
    const received = [];
    const names = [];
    mux.on('ais-message', (e) => received.push(e));
    mux.on('static-name', (e) => names.push(e));

    mux._ingestFromFeed('aishub', msg({ fixFeed: 'aishub', fixTsQuality: 'true-fix' }));
    mux._onChildStaticName('aishub', { mmsi: '265001111', shipName: 'HUBNAMN' });
    expect(received).toHaveLength(0);
    expect(names).toHaveLength(0);

    mux._ingestFromFeed('aisstream', msg());
    expect(received).toHaveLength(1);
    expect(received[0].fixFeed).toBe('aisstream');
  });

  test('🔭 SHADOW_COMPARE: fixLag + race med KORREKT teckenförklaring (fältprov 2)', () => {
    const now = Date.now();
    // aisstream tog emot positionen vid now; AISHubs fix är 40 s ÄLDRE och
    // levererades samtidigt. fixLag = mottagning − fixtid = +40000 ⇒
    // positivt betyder att AISHubs STÄMPEL är äldre (den gamla texten
    // påstod motsatsen och hade lett till fel GO-beslut).
    mux._ingestFromFeed('aisstream', msg({ timestamp: now, fixTs: now }));
    mux._ingestFromFeed('aishub', msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: now - 40000, timestamp: now,
    }));
    mux._ingestFromFeed('aishub', msg({
      mmsi: '265999999', lat: 58.30, fixFeed: 'aishub', fixTs: now, timestamp: now,
    }));

    jest.advanceTimersByTime(5 * 60 * 1000);

    const shadowLines = logger.log.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('[SHADOW_COMPARE]'));
    expect(shadowLines.length).toBeGreaterThanOrEqual(1);
    const report = shadowLines[0];
    expect(report).toContain('both=1');
    expect(report).toContain('onlyAishub=1');
    expect(report).toContain('fixLagMedianMs=40000');
    expect(report).toContain('positivt = AISHubs fixstämpel är ÄLDRE');
    // Leveranskapplöpningen: båda levererade vid now ⇒ 0.
    expect(report).toContain('raceMedianMs=0');
    expect(report).toContain('positivt = AISHub levererade till appen FÖRE aisstream');
    // p90 undertrycks vid för få sampel (1 st) — annars vore p90 = max.
    expect(report).toContain('fixLagP90Ms=-');
  });

  test('FÄLTPROV 2-FYNDET: föråldrat par förkastas — kajliggarens 3-minutersrytm får inte förgifta medianen', () => {
    const now = Date.now();
    // aisstream tog emot denna position för 40 MINUTER sedan. Båten ligger
    // still och rapporterar samma avrundade koordinat igen; AISHubs fix är
    // färsk. Utan skew-grinden parades dessa och gav ett skräpvärde på
    // −2 400 000 ms (32 % av fältprovets sampel var av den sorten).
    mux._ingestFromFeed('aisstream', msg({ timestamp: now - 40 * 60 * 1000, fixTs: now - 40 * 60 * 1000 }));
    mux._ingestFromFeed('aishub', msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: now, timestamp: now,
    }));

    jest.advanceTimersByTime(5 * 60 * 1000);
    const report = logger.log.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('[SHADOW_COMPARE]'))[0];
    expect(report).toContain('samples=0');
    expect(report).toContain('stalePairsDropped=1');
    expect(report).toContain('fixLagMedianMs=-');
  });

  test('FÄLTPROV 2: positionsindexet prunas på ÅLDER, inte bara på storlek', () => {
    const now = Date.now();
    mux._ingestFromFeed('aisstream', msg({ timestamp: now, fixTs: now }));
    expect(mux._shadowPosIndex.size).toBe(1);
    // Inom TTL: posten lever.
    jest.setSystemTime(now + 2 * 60 * 1000);
    mux.pruneFusionState();
    expect(mux._shadowPosIndex.size).toBe(1);
    // Bortom TTL (5 min): borta — tidigare rensades den först vid >500 poster
    // (indexet nådde 46 på en timme, dvs. rensades aldrig i praktiken).
    jest.setSystemTime(now + 6 * 60 * 1000);
    mux.pruneFusionState();
    expect(mux._shadowPosIndex.size).toBe(0);
  });

  test('FÄLTPROV 2: maxSilence per källa mäter kontinuitet — det AISHub faktiskt vinner på', () => {
    const now = Date.now();
    mux._ingestFromFeed('aisstream', msg({ timestamp: now, fixTs: now }));
    mux._ingestFromFeed('aishub', msg({ fixFeed: 'aishub', fixTs: now, timestamp: now }));
    // aisstream tystnar i 4 min, AISHub fortsätter var 65:e sekund.
    jest.setSystemTime(now + 65000);
    mux._ingestFromFeed('aishub', msg({
      fixFeed: 'aishub', fixTs: now + 65000, timestamp: now + 65000, lat: 58.2901,
    }));
    jest.setSystemTime(now + 4 * 60 * 1000);
    mux._ingestFromFeed('aisstream', msg({ timestamp: now + 4 * 60 * 1000, fixTs: now + 4 * 60 * 1000, lat: 58.2902 }));

    jest.advanceTimersByTime(5 * 60 * 1000);
    const report = logger.log.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('[SHADOW_COMPARE]'))[0];
    expect(report).toContain('maxSilenceAisstreamMs=240000');
    expect(report).toContain('maxSilenceAishubMs=65000');
  });

  test('FÄLTPROV 2: GO-kriteriernas råvärden loggas (AISHUB_HEALTH) — fanns i stats men skrevs aldrig', () => {
    const now = Date.now();
    mux._ingestFromFeed('aishub', msg({ fixFeed: 'aishub', fixTs: now, timestamp: now }));
    jest.advanceTimersByTime(5 * 60 * 1000);
    const health = logger.log.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('[AISHUB_HEALTH]'));
    expect(health.length).toBeGreaterThanOrEqual(1);
    // Kriterium 3 och 4 måste gå att avgöra ur loggen.
    expect(health[0]).toMatch(/timeParseFail=\d+/);
    expect(health[0]).toMatch(/emptyResponses=\d+ \([\d.]+%\)/);
    expect(health[0]).toMatch(/dedupSize=\d+/);
  });

  test('FÄLTPROV 2: slutspolning vid stopp — påbörjat fönster går inte förlorat', () => {
    const now = Date.now();
    mux._ingestFromFeed('aisstream', msg({ timestamp: now, fixTs: now }));
    mux._ingestFromFeed('aishub', msg({ fixFeed: 'aishub', fixTs: now, timestamp: now }));
    // Stoppa FÖRE 5-minutersgränsen — mätdatan ska ändå rapporteras.
    mux._stopShadowTimer();
    const finals = logger.log.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.includes('[SHADOW_COMPARE]') && l.includes('slutspolning'));
    expect(finals.length).toBe(1);
    expect(finals[0]).toContain('both=1');
  });

  test('FÄLTPROV 1-FYNDET: skugg-pollens färskhet får ALDRIG nå aggregatet — stale-vakterna ska kunna fyra', () => {
    // I skuggläge kastas varje AISHub-fix av muxen — men klienten stämplar
    // sin lastMessageTime vid emission. Räknades den in i aggregatet höll
    // 65s-pollen timeSinceLastMessage permanent färsk och app.js stale-
    // vakter (UI_FEED_STALE_GUARD/VESSEL_REMOVAL_STALE_GUARD) kunde aldrig
    // fyra vid aisstream-avbrott → "Inga båtar"-lögnen.
    mux._hubClient.isConnected = true;
    mux._hubClient.lastMessageTime = Date.now() - 5000; // pollen "levererar"

    const stats = mux.getConnectionStats();
    // Aggregatet: datalöst (aisstream inaktiv, hubben matar inte pipelinen).
    expect(stats.isConnected).toBe(false);
    expect(mux.isConnected).toBe(false);
    expect(stats.lastMessageTime).toBeNull();
    expect(stats.timeSinceLastMessage).toBeNull();
    // perFeed: råvärdena finns kvar (feed-watchdogens sanning).
    expect(stats.perFeed.aishub.isConnected).toBe(true);
    expect(Number.isFinite(stats.perFeed.aishub.timeSinceLastMessage)).toBe(true);

    // I 'both'-läget matar hubben pipelinen — då SKA den räknas.
    mux._config.source = 'both';
    const bothStats = mux.getConnectionStats();
    expect(bothStats.isConnected).toBe(true);
    expect(Number.isFinite(bothStats.timeSinceLastMessage)).toBe(true);
    mux._config.source = 'shadow'; // återställ för övriga tester
  });

  test('skuggtimern städas vid återgång till aisstream-läget', () => {
    expect(mux._shadowTimer).not.toBeNull();
    mux.applySourceConfig({ source: 'aisstream', apiKey: null, aishubUsername: 'testuser' });
    expect(mux._shadowTimer).toBeNull();
    expect(mux._hubClient).toBeNull(); // hub-barnet nedmonterat
  });
});

describe('Etapp 2: applySourceConfig — idempotens, fallback och barnhantering', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('identisk effektiv konfiguration ⇒ no-op (samma hub-instans kvarstår)', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'testuser' });
    const hub1 = mux._hubClient;
    expect(hub1).not.toBeNull();
    mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'testuser' });
    expect(mux._hubClient).toBe(hub1);
  });

  test('username-byte ⇒ gamla hub-barnet rivs (disconnect) och ett nytt skapas', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'userA' });
    const hub1 = mux._hubClient;
    const disconnectSpy = jest.spyOn(hub1, 'disconnect');
    mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'userB' });
    expect(disconnectSpy).toHaveBeenCalled();
    expect(mux._hubClient).not.toBe(hub1);
    expect(mux._hubClient.username).toBe('userB');
  });

  test('fallback-regeln: aishub-läge utan username ⇒ effektiv källa aisstream', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux.applySourceConfig({ source: 'both', apiKey: null, aishubUsername: null });
    expect(mux._config.source).toBe('aisstream');
    expect(mux._hubClient).toBeNull();
  });

  test('kickAishub når hub-barnets forceReschedule', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'testuser' });
    const spy = jest.spyOn(mux._hubClient, 'forceReschedule');
    mux.kickAishub();
    expect(spy).toHaveBeenCalled();
  });

  test('DISPOSED-RACET: disconnect() tätt efter applySourceConfig lämnar varken barn eller timers', async () => {
    // Exakt racet som hängde testworkern: _reconcile-fortsättningen (efter
    // await) landar EFTER disconnect. Disposed-vakten ska då varken skapa
    // hub-barn eller skuggtimer — och riva det som hann skapas.
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'testuser' });
    mux.disconnect(); // före mikrotaskerna
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mux._shadowTimer).toBeNull();
    expect(mux._hubClient).toBeNull();
  });
});

describe('Etapp 2: övriga styrytevägar (kontraktstäckning)', () => {
  let mux;

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
  });

  test('getConnectionStatus speglar aggregatet', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    expect(mux.getConnectionStatus()).toBe(false);
    mux._streamActive = true;
    mux._streamClient.isConnected = true;
    expect(mux.getConnectionStatus()).toBe(true);
  });

  test('connect(null) utan nyckel startar aldrig stream-barnet', async () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const connectSpy = jest.spyOn(mux._streamClient, 'connect').mockResolvedValue(undefined);
    await mux.connect(null);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(mux._streamActive).toBe(false);
  });

  test('connect(key) startar stream-barnet med nyckeln', async () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const connectSpy = jest.spyOn(mux._streamClient, 'connect').mockResolvedValue(undefined);
    await mux.connect('  KEY123  ');
    expect(connectSpy).toHaveBeenCalledWith('KEY123');
    expect(mux._streamActive).toBe(true);
  });

  test('reconnectWithKey fan-outar till stream-barnet; tom nyckel kopplar ner det', async () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const reconnectSpy = jest.spyOn(mux._streamClient, 'reconnectWithKey').mockResolvedValue(undefined);
    const disconnectSpy = jest.spyOn(mux._streamClient, 'disconnect').mockImplementation(() => {});

    await mux.reconnectWithKey('NYCKEL');
    expect(reconnectSpy).toHaveBeenCalledWith('NYCKEL');
    expect(mux._streamActive).toBe(true);

    await mux.reconnectWithKey('   ');
    expect(disconnectSpy).toHaveBeenCalled();
    expect(mux._streamActive).toBe(false);
  });

  test('stream-barnets fel-/reconnect-events re-emittas (med källa där kontraktet bär den)', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const seen = [];
    mux.on('server-error', (d, feed) => seen.push(['server-error', d, feed]));
    mux.on('error', (e, feed) => seen.push(['error', e.message, feed]));
    mux.on('reconnect-needed', () => seen.push(['reconnect-needed']));
    mux.on('max-reconnects-reached', () => seen.push(['max-reconnects-reached']));

    mux._streamClient.emit('server-error', 'överbelastad');
    mux._streamClient.emit('error', new Error('socketfel'));
    mux._streamClient.emit('reconnect-needed');
    mux._streamClient.emit('max-reconnects-reached');

    expect(seen).toEqual([
      ['server-error', 'överbelastad', 'aisstream'],
      ['error', 'socketfel', 'aisstream'],
      ['reconnect-needed'],
      ['max-reconnects-reached'],
    ]);
  });

  test('hub-barnets auth-error re-emittas med aishub som källa', async () => {
    jest.useFakeTimers();
    try {
      mux = new AISSourceMultiplexer(makeLogger(), makeStore());
      mux.applySourceConfig({ source: 'shadow', apiKey: null, aishubUsername: 'testuser' });
      // Dränera _reconcile-mikrotaskerna INOM fake-timer-fönstret — utan
      // detta skapades skuggtimern EFTER finallyns useRealTimers (äkta
      // 5-min-interval ⇒ testworkern hängde; roten till npm test-hänget).
      await Promise.resolve();
      await Promise.resolve();
      const seen = [];
      mux.on('auth-error', (d, feed) => seen.push([d, feed]));
      mux._hubClient.emit('auth-error', 'Access denied');
      expect(seen).toEqual([['Access denied', 'aishub']]);
    } finally {
      mux.disconnect();
      mux = null;
      jest.useRealTimers();
    }
  });

  test('pruneFusionState prunar utgånget state och är no-op i pass-through', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    expect(() => mux.pruneFusionState()).not.toThrow(); // tomt = ofarligt

    const FixFusionPolicy = require('../lib/connection/FixFusionPolicy'); // eslint-disable-line global-require
    const stale = FixFusionPolicy.createState();
    stale.lastAcceptedTs = Date.now() - 60 * 60 * 1000; // långt över TTL
    mux._fusionStates.set('265001111', stale);
    mux.pruneFusionState();
    expect(mux._fusionStates.size).toBe(0);
  });

  test('disconnect är idempotent (dubbelanrop kastar inte, ingen dubbelflank)', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const flanks = [];
    mux.on('disconnected', () => flanks.push('d'));
    mux.disconnect();
    mux.disconnect();
    expect(flanks).toHaveLength(0); // aldrig uppkopplad ⇒ ingen flank alls
  });
});

describe('Etapp 2: aggregerad flankemission (Bug#12/V1-M7)', () => {
  let mux;

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
  });

  test('connected/disconnected emitteras på AGGREGATETS flank — aldrig per barnhändelse', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const events = [];
    mux.on('connected', () => events.push('connected'));
    mux.on('disconnected', () => events.push('disconnected'));

    // Simulera att stream-barnet får kontakt.
    mux._streamActive = true;
    mux._streamClient.isConnected = true;
    mux._recomputeAggregate();
    mux._recomputeAggregate(); // ingen dubbelflank
    expect(events).toEqual(['connected']);
    expect(mux.isConnected).toBe(true);

    mux._streamClient.isConnected = false;
    mux._recomputeAggregate();
    expect(events).toEqual(['connected', 'disconnected']);
    expect(mux.isConnected).toBe(false);
  });

  test('felevents re-emittas med källa som andra argument', () => {
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const authArgs = [];
    mux.on('auth-error', (detail, feed) => authArgs.push([detail, feed]));
    mux._streamClient.emit('auth-error', 'Api Key Is Not Valid');
    expect(authArgs).toEqual([['Api Key Is Not Valid', 'aisstream']]);
  });
});
