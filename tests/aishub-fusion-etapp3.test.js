'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * Etapp 3 (2026-08-02): skarp fusion i 'both'-läget.
 *  - Muxens routing: ekon svalda (F1/F2b), äkta fixar vidare, feedSwitch
 *    flaggad vid källbyteshopp.
 *  - feedSwitch-plumbningen i FYRA hopp (V1-M2/V3-C3): vesselPatch →
 *    VDS syntetiska currentVessel → SystemCoordinator._handleGPSJumpEvent —
 *    den GLOBALA jump-tallyn undantas, per-fartygs-koordinationen behålls.
 *  - Kadensmedvetet gate-fönster (V1-m6).
 *  - Stale-fix-skyddet: gammalt korskälle-fix "bakåt" dömd av fysikgrindarna.
 */

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function makeStore() {
  const data = {};
  return {
    data,
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

beforeEach(() => {
  if (!jest.isMockFunction(setTimeout)) {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  }
});

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
    fixTsQuality: 'receipt',
    ...overrides,
  };
}

describe("Etapp 3: muxens routing i 'both'-läget", () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    // Direkt config-poke (samma väg som REPLAY_FUSION) — applySourceConfig
    // hade skapat ett hub-barn vars pollkedja inte behövs här.
    mux._config.source = 'both';
  });

  afterEach(() => {
    mux.disconnect();
    mux = null;
    jest.useRealTimers();
  });

  test('aisstream passerar; AISHub-EKO av samma fix svalt; äkta nytt AISHub-fix vidare', () => {
    const received = [];
    mux.on('ais-message', (e) => received.push(e));
    const now = Date.now();

    // 1) aisstream levererar.
    mux._ingestFromFeed('aisstream', msg({ fixTs: now, timestamp: now }));
    expect(received).toHaveLength(1);

    // 2) AISHub ekar SAMMA fysiska rapport i nästa poll (65 s senare,
    //    identiskt innehåll, samma fixtid) — F2b sväljer.
    jest.setSystemTime(now + 65000);
    mux._ingestFromFeed('aishub', msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: now, timestamp: now + 65000,
    }));
    expect(received).toHaveLength(1);
    expect(mux.getConnectionStats().fusion.rejected).toBe(1);

    // 3) AISHub levererar ett ÄKTA nytt fix (ny position, ny fixtid) —
    //    vidare till pipelinen med fusionsfälten.
    mux._ingestFromFeed('aishub', msg({
      fixFeed: 'aishub',
      fixTsQuality: 'true-fix',
      fixTs: now + 60000,
      timestamp: now + 65000,
      lat: 58.2905,
    }));
    expect(received).toHaveLength(2);
    expect(received[1].fixFeed).toBe('aishub');
    expect(received[1].fixTs).toBe(now + 60000);
    expect(received[1].feedSwitch).toBe(false);
  });

  test('källbyteshopp > 150 m inom 30 s ⇒ feedSwitch: true på emitterat meddelande', () => {
    const received = [];
    mux.on('ais-message', (e) => received.push(e));
    const now = Date.now();

    mux._ingestFromFeed('aisstream', msg({ fixTs: now, timestamp: now }));
    jest.setSystemTime(now + 10000);
    mux._ingestFromFeed('aishub', msg({
      fixFeed: 'aishub',
      fixTsQuality: 'true-fix',
      fixTs: now + 5000,
      timestamp: now + 10000,
      lat: 58.29 + 300 / 111320, // ~300 m norrut — två mottagares GPS-vy
    }));

    expect(received).toHaveLength(2);
    expect(received[1].feedSwitch).toBe(true);
    expect(mux.getConnectionStats().fusion.feedSwitches).toBe(1);
  });

  test('för gammalt fix (> MAX_FIX_AGE) svalt av F4b', () => {
    const received = [];
    mux.on('ais-message', (e) => received.push(e));
    const now = Date.now();
    mux._ingestFromFeed('aishub', msg({
      fixFeed: 'aishub',
      fixTsQuality: 'true-fix',
      fixTs: now - AIS_CONFIG.FUSION.MAX_FIX_AGE_MS - 1000,
      timestamp: now,
    }));
    expect(received).toHaveLength(0);
  });
});

describe('FÄLTPROV 3: fusionsfälten sätts VID KÄLLAN — harnessen får inte maskera produktionen', () => {
  test('AISStreamClient._extractAISData bär fixTs/fixFeed/fixTsQuality', () => {
    // eslint-disable-next-line global-require
    const AISStreamClient = require('../lib/connection/AISStreamClient');
    const client = new AISStreamClient(makeLogger());
    const out = client._extractAISData({
      MessageType: 'PositionReport',
      MetaData: {
        MMSI: 265001111, Latitude: 58.29, Longitude: 12.29, ShipName: 'KÄLLPROV',
      },
      Message: { PositionReport: { MMSI: 265001111, Sog: 5, Cog: 25 } },
    });
    expect(out).not.toBeNull();
    expect(out.fixFeed).toBe('aisstream');
    expect(out.fixTsQuality).toBe('receipt');
    expect(Number.isFinite(out.fixTs)).toBe(true);
    // Mottagningstid och fixtid är SAMMA stämpel för en pushande källa.
    expect(out.fixTs).toBe(out.timestamp);
  });

  test('F5 fyrar på ett ÄKTA aisstream→AISHub-källbyte utan harness-injektion', () => {
    // Buggen: utan fixFeed vid källan blev state.lastFeed undefined (falsy)
    // och F5-grinden hoppades över för hela riktningen aisstream→AISHub.
    // Detta test matar EXAKT det klienten producerar — ingen injektion.
    // eslint-disable-next-line global-require
    const AISStreamClient = require('../lib/connection/AISStreamClient');
    const client = new AISStreamClient(makeLogger());
    const streamMsg = client._extractAISData({
      MessageType: 'PositionReport',
      MetaData: {
        MMSI: 265001111, Latitude: 58.29, Longitude: 12.29, ShipName: 'SWITCH',
      },
      Message: { PositionReport: { MMSI: 265001111, Sog: 5, Cog: 0 } },
    });

    const mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    try {
      mux._config.source = 'both';
      const seen = [];
      mux.on('ais-message', (m) => seen.push(m));

      mux._ingestFromFeed('aisstream', streamMsg);
      // AISHub-fix ~300 m bort, 45 s senare — INOM det nya 90s-fönstret
      // (med det gamla 30s-fönstret hann ett källbyte aldrig ske i tid).
      jest.advanceTimersByTime(45000);
      mux._ingestFromFeed('aishub', {
        ...streamMsg,
        lat: 58.29 + 300 / 111320,
        fixFeed: 'aishub',
        fixTsQuality: 'true-fix',
        fixTs: Date.now(),
        timestamp: Date.now(),
      });

      expect(seen).toHaveLength(2);
      expect(seen[1].feedSwitch).toBe(true);
      expect(mux.getConnectionStats().fusion.feedSwitches).toBe(1);
    } finally {
      mux.disconnect();
    }
  });
});

describe('Etapp 3: feedSwitch-plumbningen i fyra hopp (V1-M2/V3-C3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('app._processAISMessage: vesselPatch bär feedSwitch', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._replayCaptureFile = null;
    app.vesselDataService = { updateVessel: jest.fn() };

    app._processAISMessage({
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 5, cog: 25, feedSwitch: true,
    });
    expect(app.vesselDataService.updateVessel.mock.calls[0][1].feedSwitch).toBe(true);

    app._processAISMessage({
      mmsi: '265001111', lat: 58.29, lon: 12.29, sog: 5, cog: 25,
    });
    expect(app.vesselDataService.updateVessel.mock.calls[1][1].feedSwitch).toBe(false);
  });

  test('HELKEDJAN: källbyteshopp med feedSwitch räknas ALDRIG i den globala jump-tallyn — utan flaggan räknas det', () => {
    const logger = makeLogger();
    const systemCoordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, new BridgeRegistry(), systemCoordinator);
    const t0 = Date.now();

    // Bas: aisstream-fix.
    service.updateVessel('265001111', {
      lat: 58.29, lon: 12.29, sog: 5, cog: 0, name: 'SWITCHPROV', fixTs: t0, fixFeed: 'aisstream',
    });

    // Källbyte 2 s senare: AISHub-fix 700 m norrut (olika feeds ⇒ analyzern
    // faller på mottagningstids-dt 2 s ⇒ fysiskt omöjligt ⇒ isGPSJump) MED
    // feedSwitch — den globala tallyn ska stå still.
    jest.advanceTimersByTime(2000);
    service.updateVessel('265001111', {
      lat: 58.29 + 700 / 111320,
      lon: 12.29,
      sog: 5,
      cog: 0,
      name: 'SWITCHPROV',
      fixTs: t0 - 40000,
      fixFeed: 'aishub',
      feedSwitch: true,
    });
    expect(systemCoordinator.globalSystemState.recentJumpers.size).toBe(0);

    // Kontrollfall: ett ANNAT fartyg gör samma hopp UTAN flaggan ⇒ räknas.
    service.updateVessel('265002222', {
      lat: 58.29, lon: 12.29, sog: 5, cog: 0, name: 'VANLIGHOPP', fixTs: t0, fixFeed: 'aisstream',
    });
    jest.advanceTimersByTime(2000);
    service.updateVessel('265002222', {
      lat: 58.29 + 700 / 111320,
      lon: 12.29,
      sog: 5,
      cog: 0,
      name: 'VANLIGHOPP',
      fixTs: t0 - 40000,
      fixFeed: 'aishub',
      feedSwitch: false,
    });
    expect(systemCoordinator.globalSystemState.recentJumpers.size).toBe(1);
    expect(systemCoordinator.globalSystemState.recentJumpers.has('265002222')).toBe(true);
  });

  test('per-fartygs-koordinationen BEHÅLLS vid feedSwitch (bara den globala tallyn undantas)', () => {
    const logger = makeLogger();
    const sc = new SystemCoordinator(logger);
    const rec = sc.coordinatePositionUpdate(
      '265001111',
      { isGPSJump: true, action: 'gps_jump_detected', movementDistance: 700 },
      { feedSwitch: true, sog: 5, cog: 0 },
      { sog: 5, cog: 0 },
    );
    // Skydd/stabilisering för fartyget aktiveras fortfarande…
    expect(rec.shouldActivateProtection).toBe(true);
    // …men den globala tallyn står still.
    expect(sc.globalSystemState.recentJumpers.size).toBe(0);
  });
});

describe('Etapp 3: kadensmedvetet gate-fönster (V1-m6)', () => {
  beforeEach(() => {
    global.__TEST_MODE__ = true;
  });

  afterEach(() => {
    global.__TEST_MODE__ = undefined;
  });

  test('setPollCadenceMs: 65 s-poll ⇒ 97.5 s-fönster; null ⇒ basens 30 s', () => {
    const gate = new GPSJumpGateService(makeLogger(), null);
    expect(gate._gateTimeout).toBe(30000);
    gate.setPollCadenceMs(65000);
    expect(gate._gateTimeout).toBe(97500);
    gate.setPollCadenceMs(null);
    expect(gate._gateTimeout).toBe(30000);
  });

  test('_applyAisSourceConfig sätter kadensen för both/aishub men INTE för shadow', () => {
    const makeApp = (settings) => {
      const app = new AISBridgeApp();
      app.log = jest.fn();
      app.error = jest.fn();
      app.debug = jest.fn();
      const store = { ...settings };
      app.homey = { settings: { get: (k) => (k in store ? store[k] : null), on: jest.fn() } };
      app.aisClient = { applySourceConfig: jest.fn() };
      app.gpsJumpGateService = { setPollCadenceMs: jest.fn() };
      app._notifyConnectionIssue = jest.fn();
      return app;
    };

    const both = makeApp({ ais_api_key: 'K', aishub_username: 'u', ais_source: 'both' });
    both._applyAisSourceConfig();
    expect(both.gpsJumpGateService.setPollCadenceMs).toHaveBeenCalledWith(AIS_CONFIG.AISHUB.POLL_INTERVAL_MS);

    const shadow = makeApp({ ais_api_key: 'K', aishub_username: 'u', ais_source: 'shadow' });
    shadow._applyAisSourceConfig();
    expect(shadow.gpsJumpGateService.setPollCadenceMs).toHaveBeenCalledWith(null);

    // Fallback (username saknas): effektiv källa aisstream ⇒ basfönstret.
    const fallback = makeApp({ ais_api_key: 'K', ais_source: 'both' });
    fallback._applyAisSourceConfig();
    expect(fallback.gpsJumpGateService.setPollCadenceMs).toHaveBeenCalledWith(null);
  });
});

describe('Etapp 3: stale-fix-skyddet — gammalt korskälle-fix bakåt döms av fysikgrindarna', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('3 min gammalt AISHub-fix 300 m bakom färskt aisstream-fix ⇒ positionUncertain, aldrig ren accept', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const now = Date.now();
    // Färskt stream-fix norrut; gammalt hub-fix pekar 300 m SÖDER om det.
    // Olika källor ⇒ fixtids-dt är odefinierat ⇒ mottagningstids-dt (2 s)
    // ⇒ 300 m är fysiskt orimligt ⇒ accept_with_caution (positionUncertain
    // nedströms) — det gamla fixet får aldrig teleportera båten rent.
    const streamVessel = {
      sog: 3, cog: 0, timestamp: now - 2000, fixTs: now - 2000, fixFeed: 'aisstream',
    };
    const hubVessel = {
      sog: 3, cog: 0, timestamp: now, fixTs: now - 180000, fixFeed: 'aishub',
    };
    const streamPos = { lat: 58.29 + 300 / 111320, lon: 12.29 };
    const hubPosBehind = { lat: 58.29, lon: 12.29 };

    const result = analyzer.analyzeMovement('265001111', hubPosBehind, streamPos, hubVessel, streamVessel);
    expect(result.action).toBe('accept_with_caution');
    expect(result.reason).toBe('medium_movement_speed_mismatch');
  });
});
