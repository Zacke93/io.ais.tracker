'use strict';

jest.mock('homey');

/**
 * Helgranskningen 2026-07-06 — regressionstester för fixpaketen.
 *
 * F1: sog=null-familjen (SOG-sentinelen 102.3, waiting-timer-kraschen,
 *     ANCHOR_BLOCK, fartgrindarna, D-1 falsy-fallbacken).
 * Fler paket (F2–F6) fyller på i denna fil.
 */

const AISStreamClient = require('../lib/connection/AISStreamClient');
const VesselDataService = require('../lib/services/VesselDataService');
const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');

const mockLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

describe('F1: SOG-sentinelen 102.3 normaliseras till null (aisclient#1)', () => {
  function extract(sogValue) {
    const client = new AISStreamClient(mockLogger());
    return client._extractAISData({
      MessageType: 'PositionReport',
      MetaData: {
        MMSI: 265000001, Latitude: 58.28, Longitude: 12.28, SOG: sogValue, COG: 30,
      },
      Message: { PositionReport: {} },
    });
  }

  test('SOG 102.3 (rå 1023 = "ej tillgänglig") blir null — inte avvisad rapport', () => {
    const data = extract(102.3);
    expect(data).not.toBeNull();
    expect(data.sog).toBeNull();
    expect(data.lat).toBe(58.28);
  });

  test('SOG 102.2 ("102,2 kn eller mer" — nonsens i kanalen) blir null', () => {
    expect(extract(102.2).sog).toBeNull();
  });

  test('normal SOG passerar orörd', () => {
    expect(extract(4.7).sog).toBe(4.7);
    expect(extract(0).sog).toBe(0);
  });

  test('saknad SOG blir null (oförändrat kontrakt)', () => {
    expect(extract(undefined).sog).toBeNull();
  });
});

describe('F1: _updateWaitingTimer kraschar inte på sog=null (status-1#1)', () => {
  test('sog=null startar waiting-timern utan TypeError och statusresultatet överlever', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = new StatusService(new BridgeRegistry(), mockLogger(), new SystemCoordinator(mockLogger()));
      const vessel = {
        mmsi: '265000002', sog: null, cog: 30, lat: 58.284, lon: 12.2839,
      };
      expect(() => svc._updateWaitingTimer(vessel, { status: 'waiting' })).not.toThrow();
      // Semantiken behålls: okänd fart räknas konservativt som "kan vänta".
      expect(vessel.speedBelowThresholdSince).toEqual(expect.any(Number));
      // Andra anropet (timern redan satt) ska inte heller kasta.
      expect(() => svc._updateWaitingTimer(vessel, { status: 'waiting' })).not.toThrow();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('finit sog loggar med formaterad fart (ingen regressions-ändring)', () => {
    global.__TEST_MODE__ = true;
    try {
      const logger = mockLogger();
      const svc = new StatusService(new BridgeRegistry(), logger, new SystemCoordinator(mockLogger()));
      const vessel = { mmsi: '265000003', sog: 0.1 };
      svc._updateWaitingTimer(vessel, { status: 'waiting' });
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('0.10kn'));
    } finally {
      delete global.__TEST_MODE__;
    }
  });
});

describe('F1: målbrogrindar blockerar inte okänd fart (vds-3#1, vds-3#2)', () => {
  function makeVds() {
    const svc = new VesselDataService(mockLogger(), new BridgeRegistry(), new SystemCoordinator(mockLogger()));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    return svc;
  }

  test('ANCHOR_BLOCK: null-sog efter passage hårdblockerar INTE måltilldelning', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      // Nordgående med rörelsebevis, Klaffbron passerad, på väg mot Strids
      // (~430 m söder om Stridsbergsbron, >300 m från alla broar).
      const vessel = {
        mmsi: '265000004',
        lat: BRIDGES.stridsbergsbron.lat - 0.0039,
        lon: BRIDGES.stridsbergsbron.lon - 0.0005,
        sog: null,
        cog: 30,
        passedBridges: ['Klaffbron'],
        _hasMovementProof: true,
      };
      const result = svc._shouldAssignTargetBridge(vessel, null);
      const anchorBlocked = svc.logger.debug.mock.calls
        .some(([msg]) => typeof msg === 'string' && msg.includes('ANCHOR_BLOCK'));
      expect(anchorBlocked).toBe(false);
      expect(result).toBe(true);
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('ANCHOR_BLOCK: känd stillaliggande fart (0.1 kn) blockerar fortfarande', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      const vessel = {
        mmsi: '265000005',
        lat: BRIDGES.stridsbergsbron.lat - 0.0039,
        lon: BRIDGES.stridsbergsbron.lon - 0.0005,
        sog: 0.1,
        cog: 30,
        passedBridges: ['Klaffbron'],
        _hasMovementProof: true,
      };
      const result = svc._shouldAssignTargetBridge(vessel, null);
      expect(result).toBe(false);
      const anchorBlocked = svc.logger.debug.mock.calls
        .some(([msg]) => typeof msg === 'string' && msg.includes('ANCHOR_BLOCK'));
      expect(anchorBlocked).toBe(true);
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('fartgrind >500 m: null-sog med rörelsebevis avvisas INTE som "too slow"', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      // ~700 m söder om Klaffbron, inga passager än, bevisad rörelse.
      const vessel = {
        mmsi: '265000006',
        lat: BRIDGES.klaffbron.lat - 0.0063,
        lon: BRIDGES.klaffbron.lon,
        sog: null,
        cog: 25,
        passedBridges: [],
        _hasMovementProof: true,
      };
      svc._shouldAssignTargetBridge(vessel, null);
      const tooSlow = svc.logger.debug.mock.calls
        .some(([msg]) => typeof msg === 'string' && msg.includes('Too slow for target bridge'));
      expect(tooSlow).toBe(false);
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });
});

describe('F2: BRIDGE_GAPS matchar brokoordinaternas haversine (constants#1/#2)', () => {
  const { BRIDGE_GAPS } = require('../lib/constants');

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const PAIRS = [
    ['olidebron', 'klaffbron'],
    ['klaffbron', 'jarnvagsbron'],
    ['jarnvagsbron', 'stridsbergsbron'],
    ['stridsbergsbron', 'stallbackabron'],
  ];

  test.each(PAIRS)('gapet %s-%s ligger inom 10 m från haversine', (a, b) => {
    const d = haversine(BRIDGES[a].lat, BRIDGES[a].lon, BRIDGES[b].lat, BRIDGES[b].lon);
    const gap = BRIDGE_GAPS[`${a}-${b}`];
    expect(gap).toBeDefined();
    // Datafelen som fixades var 413 m resp. 163 m fel — 10 m-tolerans låser
    // semantiken "rät fågelvägssträcka" mot koordinaterna för all framtid.
    expect(Math.abs(gap - d)).toBeLessThanOrEqual(10);
  });
});

describe('F3: koordinationsnivån når konsumenterna (vds-4#1, 8:e fältlistoffret)', () => {
  function makeVds() {
    const svc = new VesselDataService(mockLogger(), new BridgeRegistry(), new SystemCoordinator(mockLogger()));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    return svc;
  }

  test('_applyCoordinationResults skriver lastCoordinationLevel (fältet konsumenterna läser)', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      const vessel = { mmsi: '265000010' };
      svc._applyCoordinationResults('265000010', vessel, null, {
        stabilizationLevel: 'enhanced', coordinationActive: true, reason: 'gps_jump', shouldActivateProtection: false,
      });
      expect(vessel.lastCoordinationLevel).toBe('enhanced');
      // Släpper koordinationen ska nivån nollas — annars fastnar
      // ETA-outlierdämpningen för evigt.
      svc._applyCoordinationResults('265000010', vessel, null, {
        stabilizationLevel: 'normal', coordinationActive: false, reason: 'none', shouldActivateProtection: false,
      });
      expect(vessel.lastCoordinationLevel).toBeNull();
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('lastCoordinationLevel överlever _createVesselObject (fältlistan)', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      const oldVessel = { lastCoordinationLevel: 'system_wide', lat: 58.28, lon: 12.28 };
      const rebuilt = svc._createVesselObject('265000011', {
        lat: 58.281, lon: 12.281, sog: 4, cog: 30, name: 'TEST',
      }, oldVessel);
      expect(rebuilt.lastCoordinationLevel).toBe('system_wide');
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });
});

describe('F4: timeout-removal räknas som avslutad resa ENDAST efter målbropassage (vds-1#R2-1)', () => {
  function makeVds() {
    const svc = new VesselDataService(mockLogger(), new BridgeRegistry(), new SystemCoordinator(mockLogger()));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    return svc;
  }

  test('mållös båt med bara Olidebron passerad + timeout ⇒ INGEN completed journey (ingen 10-min AIS-blackout)', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      const vessel = svc.updateVessel('265000020', {
        lat: 58.278, lon: 12.278, sog: 4, cog: 25, name: 'GAPBÅT',
      });
      expect(vessel).toBeTruthy();
      vessel.targetBridge = null;
      vessel.passedBridges = ['Olidebron'];
      svc.removeVessel('265000020', 'timeout');
      expect(svc._completedJourneys.has('265000020')).toBe(false);
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('FÄLTPROV (LYS): målbroar passerade men INTE riktningens sista bro ⇒ INGEN completed-post', () => {
    // LYS 2026-07-07 10:14: sydgående, Strids+Klaffbron passerade, timeout
    // MELLAN Klaffbron och Olidebron → completed-posten + reentry-blocket
    // åt upp gap-failsafen för Olidebron/Kanalinfarten (2 missade notiser).
    // Syd är avslutad först vid Olidebron.
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      const vessel = svc.updateVessel('265000024', {
        lat: 58.2760, lon: 12.2770, sog: 4.5, cog: 205, name: 'LYS-TEST',
      });
      expect(vessel).toBeTruthy();
      vessel.targetBridge = null;
      vessel._routeDirection = 'south';
      vessel.passedBridges = ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'];
      svc.removeVessel('265000024', 'timeout');
      expect(svc._completedJourneys.has('265000024')).toBe(false);
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('målbro (Klaffbron) i passedBridges + timeout ⇒ completed journey registreras (Bug E-fallet bevarat)', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = makeVds();
      const vessel = svc.updateVessel('265000021', {
        lat: 58.270, lon: 12.273, sog: 4, cog: 205, name: 'KLARBÅT',
      });
      expect(vessel).toBeTruthy();
      vessel.targetBridge = null;
      // Fältprov-skärpningen 2026-07-07: completed-timeout kräver
      // riktningsslutförd resa (syd ⇒ Olidebron passerad) + känd riktning.
      vessel._routeDirection = 'south';
      vessel.passedBridges = ['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron', 'Olidebron'];
      svc.removeVessel('265000021', 'timeout');
      expect(svc._completedJourneys.has('265000021')).toBe(true);
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });
});

describe('F4: passage-latchens reversal-release kräver två konsekutiva motsatta samples (route-latch#2)', () => {
  const PassageLatchService = require('../lib/services/PassageLatchService');

  test('ett enda brusigt syd-sampel släpper INTE nord-latchen; två gör det', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = new PassageLatchService(mockLogger());
      svc.registerPassage('265000022', 'Stallbackabron', 'north');
      // Ett motsatta sampel: fortfarande blockerad (pending).
      expect(svc.shouldBlockStatus('265000022', 'Stallbackabron', 'approaching', 200)).toBe(true);
      // Andra konsekutiva motsatta sampel: släpp.
      expect(svc.shouldBlockStatus('265000022', 'Stallbackabron', 'approaching', 205)).toBe(false);
      if (typeof svc.destroy === 'function') svc.destroy();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('brus som återgår till passageriktningen nollställer reversal-kandidaten', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = new PassageLatchService(mockLogger());
      svc.registerPassage('265000023', 'Stallbackabron', 'north');
      expect(svc.shouldBlockStatus('265000023', 'Stallbackabron', 'approaching', 200)).toBe(true); // pending syd
      expect(svc.shouldBlockStatus('265000023', 'Stallbackabron', 'approaching', 30)).toBe(true); // åter nord → nollställ
      // Nästa syd-sampel är alltså FÖRSTA igen → fortfarande blockerad.
      expect(svc.shouldBlockStatus('265000023', 'Stallbackabron', 'approaching', 200)).toBe(true);
      if (typeof svc.destroy === 'function') svc.destroy();
    } finally {
      delete global.__TEST_MODE__;
    }
  });
});

describe('F4: StatusService.destroy river ETA-kalkylatorns intervall (app-9#1)', () => {
  test('destroy() anropar progressiveETACalculator.destroy()', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = new StatusService(new BridgeRegistry(), mockLogger(), new SystemCoordinator(mockLogger()));
      const spy = jest.spyOn(svc.progressiveETACalculator, 'destroy');
      svc.destroy();
      expect(spy).toHaveBeenCalled();
    } finally {
      delete global.__TEST_MODE__;
    }
  });
});

describe('FÄLTPROV 2026-07-07: sessionsdedupens riktningsundantag (ELFKUNGEN-returmissarna)', () => {
  // Fyra missade returnotiser i 14h-fältprovet: sessionsnycklarna från den
  // nordgående turen överlevde removal (BUG7-bevarandet) och blockerade
  // returens failsafe-notiser trots att persistent-lagret korrekt släppte
  // ("direction flipped"). Sessionschecken speglar nu persistent-logiken.
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
  });
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = undefined;
  });

  function makeDedupeApp() {
    // eslint-disable-next-line global-require
    const AISBridgeApp = require('../app');
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._boatNearTrigger = { trigger: jest.fn().mockResolvedValue(undefined) };
    app.vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(false) };
    app._triggeredBoatNearKeys = new Set(['265573130:Stallbackabron']);
    app._persistentRecentTriggers = new Map([
      // Nordgående turens post, 78 min gammal (inom 2h-fönstret).
      ['265573130:Stallbackabron', { t: Date.now() - 78 * 60 * 1000, dir: 'north' }],
    ]);
    return app;
  }

  const returVessel = () => ({
    mmsi: '265573130',
    name: 'ELFKUNGEN',
    sog: 7.8,
    cog: 220, // sydgående retur
    _hasMovementProof: true,
    _moored: false,
    lat: 58.3053,
    lon: 12.3093,
    targetBridge: 'Stridsbergsbron',
    status: 'en-route',
    timestamp: Date.now(),
    _lastSeen: Date.now(),
  });

  test('motriktad returpassage SLÄPPS trots kvarvarande sessionsnyckel (kortet avfyras)', async () => {
    const app = makeDedupeApp();
    await app._triggerBoatNearFlowForBridge(returVessel(), {
      name: 'Stallbackabron', id: 'stallbackabron', distance: 744, source: 'passage-fallback',
    });
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('FLOW_TRIGGER_DEDUPE_DIRECTION'));
    expect(app._boatNearTrigger.trigger).toHaveBeenCalledTimes(1);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('SAMMA riktning blockeras fortfarande (äkta dubblett-skyddet intakt)', async () => {
    const app = makeDedupeApp();
    const northAgain = { ...returVessel(), cog: 20 }; // fortfarande nordgående
    await app._triggerBoatNearFlowForBridge(northAgain, {
      name: 'Stallbackabron', id: 'stallbackabron', distance: 744, source: 'passage-fallback',
    });
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('FLOW_TRIGGER_DEDUPE]'));
    expect(app._boatNearTrigger.trigger).not.toHaveBeenCalled();
  });

  test('okänd aktuell riktning (cog null utan ruttlås) blockeras konservativt', async () => {
    const app = makeDedupeApp();
    const unknownDir = { ...returVessel(), cog: null };
    await app._triggerBoatNearFlowForBridge(unknownDir, {
      name: 'Stallbackabron', id: 'stallbackabron', distance: 744, source: 'passage-fallback',
    });
    expect(app._boatNearTrigger.trigger).not.toHaveBeenCalled();
  });
});

describe('T3: projektions-fältlistvakten (t-bridge-text#R2-2 — fältlist-fällans 3:e lista)', () => {
  // BridgeText-projektionen (_findRelevantBoatsForBridgeText) är den TREDJE
  // explicita fältlistan (9:e offret bevisade dess farlighet). Vakten har två
  // lager: (1) projektionen bär varje fält textmotorn läser idag;
  // (2) AUTOMATISK källkodssvepning — läser textmotorns källa och faller om
  // en FRAMTIDA vessel-fältläsning införs utan att vakten uppdateras.
  const PROJECTION_CONSUMED_FIELDS = [
    'mmsi', 'targetBridge', 'etaMinutes', 'passedBridges',
    'distanceToCurrent', '_isImminentAtTargetBridge', '_etaIsExtrapolated',
    // Fältprov 4b (2026-07-09): under-MÅLBRON-dominansen i gruppklausulen
    // läser status + currentBridge — båda bärs av projektionen.
    'status', 'currentBridge',
  ];

  function makeProjectionApp() {
    // eslint-disable-next-line global-require
    const AISBridgeApp = require('../app');
    const app = Object.create(AISBridgeApp.prototype);
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app._processingRemoval = new Set();
    app.vesselDataService = {
      getVesselsForBridgeText: () => [{
        mmsi: '265000030',
        name: 'PROJTEST',
        targetBridge: 'Klaffbron',
        etaMinutes: 5,
        isWaiting: false,
        status: 'approaching',
        lastPassedBridge: null,
        lastPassedBridgeTime: null,
        sog: 4,
        cog: 30,
        passedBridges: [],
        _routeDirection: 'north',
        _finalTargetDirection: null,
        _bridgeOpeningUntil: null,
        _etaIsExtrapolated: false,
        _isImminentAtTargetBridge: false,
        lat: 58.28,
        lon: 12.28,
      }],
    };
    app.proximityService = {
      analyzeVesselProximity: () => ({
        nearestBridge: { name: 'Klaffbron' },
        nearestDistance: 250,
        bridgeDistances: {},
      }),
    };
    app.bridgeRegistry = { findBridgeIdByName: () => 'klaffbron' };
    return app;
  }

  test('projektionen bär varje fält textmotorn konsumerar', () => {
    const proj = makeProjectionApp()._findRelevantBoatsForBridgeText();
    expect(proj).toHaveLength(1);
    for (const field of PROJECTION_CONSUMED_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(proj[0], field)).toBe(true);
    }
  });

  test('KÄLLSVEP: textmotorn läser inga vessel-fält utanför vaktlistan', () => {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const path = require('path');
    const sources = [
      fs.readFileSync(path.join(__dirname, '../lib/services/BridgeTextService.js'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../lib/utils/CountTextHelper.js'), 'utf8'),
    ].join('\n');
    // Fältläsningar på vessel-liknande variabler; metodanrop (`.foo(`)
    // exkluderas av negativ lookahead.
    const re = /\b(?:v|vessel|lead|first)\.(_?[a-zA-Z][a-zA-Z0-9_]*)\b(?!\s*\()/g;
    const seen = new Set();
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(sources)) !== null) seen.add(m[1]);
    const unexpected = [...seen].filter((f) => !PROJECTION_CONSUMED_FIELDS.includes(f));
    // Faller ett NYTT fält in här: lägg det i projektionen (app.js
    // _findRelevantBoatsForBridgeText) OCH i PROJECTION_CONSUMED_FIELDS —
    // annars är fältet tyst undefined i publiceringsvägen (9:e offret).
    expect(unexpected).toEqual([]);
  });
});

describe('T2: Fix 5-gaten på den RIKTIGA notisvägen (t-notification-reliability#1)', () => {
  // _triggerBoatNearFlow kortsluter i test-läge — stäng av det (samma teknik
  // som RC-S3-sviten/replay-harnessen) så den VERKLIGA gaten exekveras.
  // Gamla Fix 5-testerna prövade en egendefinierad mock mot sig själv.
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
  });
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = undefined;
  });

  function makeGateApp(holdActive) {
    // eslint-disable-next-line global-require
    const AISBridgeApp = require('../app');
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._boatNearTrigger = { trigger: jest.fn().mockResolvedValue(undefined) };
    app.vesselDataService = { hasGpsJumpHold: jest.fn().mockReturnValue(holdActive) };
    return app;
  }

  const freshVessel = () => ({
    mmsi: '265700001',
    sog: 4.2,
    _hasMovementProof: true,
    _moored: false,
    lat: 58.2835,
    lon: 12.2838,
    targetBridge: 'Klaffbron',
    status: 'approaching',
    timestamp: Date.now(),
    _lastSeen: Date.now(),
  });

  test('aktiv GPS-hold blockerar notisvägen (Fix 5) — inget kort avfyras', async () => {
    const app = makeGateApp(true);
    await app._triggerBoatNearFlow(freshVessel());
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('FLOW_TRIGGER_GPS_HOLD'));
    expect(app._boatNearTrigger.trigger).not.toHaveBeenCalled();
  });

  test('utan hold passeras Fix 5-gaten (ingen GPS_HOLD-skip)', async () => {
    const app = makeGateApp(false);
    await app._triggerBoatNearFlow(freshVessel());
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('FLOW_TRIGGER_GPS_HOLD'));
  });

  test('förtöjd båt blockeras före GPS-gaten (mooring-lagret)', async () => {
    const app = makeGateApp(false);
    await app._triggerBoatNearFlow({ ...freshVessel(), _moored: true });
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('Vessel is moored/anchored'));
    expect(app._boatNearTrigger.trigger).not.toHaveBeenCalled();
  });
});

describe('T2: ETA-klausulens extrapolerad-under-3-gren (t-bridge-text#R2-5, docs-core#5)', () => {
  const { formatETABroOpeningClause } = require('../lib/utils/etaValidation');

  test('extrapolerad ETA < 3 min ger "om cirka 2 minuter" — INTE "strax" (MARLIN-fallet)', () => {
    expect(formatETABroOpeningClause(1.4, { extrapolated: true }))
      .toBe('beräknad broöppning om cirka 2 minuter');
  });

  test('färsk ETA < 3 min ger "strax"; imminent vinner över allt', () => {
    expect(formatETABroOpeningClause(1.4, {})).toBe('beräknad broöppning strax');
    expect(formatETABroOpeningClause(45, { imminent: true })).toBe('beräknad broöppning strax');
  });

  test('extrapolerad ETA ≥ 3 min ger "om cirka N minuter"', () => {
    expect(formatETABroOpeningClause(7.2, { extrapolated: true }))
      .toBe('beräknad broöppning om cirka 7 minuter');
  });
});

describe('F1/D-1: jumpanalysen får legitima 0-värden (?? i stället för ||)', () => {
  test('cog=0 och sog=0 skickas till analyzern i stället för gamla värden', () => {
    global.__TEST_MODE__ = true;
    try {
      const svc = new VesselDataService(mockLogger(), new BridgeRegistry(), new SystemCoordinator(mockLogger()));
      svc.app = {
        gpsJumpGateService: null,
        passageLatchService: null,
        routeOrderValidator: null,
        debug: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
      };
      const seen = [];
      const orig = svc.gpsJumpAnalyzer.analyzeMovement.bind(svc.gpsJumpAnalyzer);
      svc.gpsJumpAnalyzer.analyzeMovement = (mmsi, cur, prev, curVessel, oldVessel) => {
        seen.push({ cog: curVessel.cog, sog: curVessel.sog });
        return orig(mmsi, cur, prev, curVessel, oldVessel);
      };
      // Första meddelandet: etablera oldVessel med cog 180 / sog 5.
      svc.updateVessel('265000007', {
        lat: 58.2800, lon: 12.2810, sog: 5, cog: 180, name: 'DIRIGENT',
      });
      // Andra meddelandet: legitim nordkurs 0° och stillalägge 0 kn.
      svc.updateVessel('265000007', {
        lat: 58.2801, lon: 12.2810, sog: 0, cog: 0, name: 'DIRIGENT',
      });
      expect(seen.length).toBeGreaterThanOrEqual(1);
      const last = seen[seen.length - 1];
      expect(last.cog).toBe(0);
      expect(last.sog).toBe(0);
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });
});
