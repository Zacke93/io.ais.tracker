'use strict';

/**
 * U40 (N4, 2026-11-16) — ETT STOPP SOM FÄRDEN FÖRKLARAR ÄR INGET GPS-HOPP.
 *
 * SITUATIONEN. En båt går söderut i 5,2 kn, 517 m norr om Stridsbergsbron.
 * Nästa fix kommer 200 s senare: 120 m bortom bron, sog 0 och en stillakurs
 * 44,8° från den gamla. 638 m på 200 s är 6,2 kn i snitt. Stillakursen pekar
 * ~50° fel mot förflyttningen och snittfarten är över 5 kn mot sog 0, så
 * legitimitetspoängen hamnar under 0,4 och analysen dömde fixen som GPS-hopp
 * (`likely_gps_error`). Orimlighetsflaggan spärrade passagen tills nästa fix
 * 16 min senare, och K1:s undantag i stillagrinden nåddes aldrig.
 *
 * RÄTTNINGEN: i analysatorns `likely_gps_error`-gren blir en stillafix (sog
 * under MOVEMENT_PROOF_SOG_KN) osäker (`stop_after_transit`) i stället för ett
 * hopp när GPSJumpAnalyzer.stopExplainedByPriorTransit håller — EN regel med
 * K1. Stillagrinden och K1:s undantag avgör sedan passagen per bro, med
 * jitterbandet kring brolinjen.
 *
 * Sviten låser:
 *   A. Analysatorn: stoppet blir osäkert, inte ett hopp (rött före N4).
 *   B. Motfallen på analysnivå: verkliga hopp döms exakt som förut.
 *   C. Riktiga pipelinen: passagen bokförs på stillafixen (rött före N4), och
 *      motfallen (brus inom jitterbandet, kajliggare, hopp längre än färden)
 *      bokför ingenting.
 * Stillafixen ska ligga utanför jitterbandet (UNDER_BRIDGE_CROSS_PROOF_JITTER_M)
 * kring varje brolinje; inom bandet döms den som förut.
 */

jest.mock('homey');

const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const { BRIDGES } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const R = 6371000;
const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});
const dest = (p, brg, d) => {
  const la = (p.lat * Math.PI) / 180;
  const lo = (p.lon * Math.PI) / 180;
  const b = (brg * Math.PI) / 180;
  const dr = d / R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (lo2 * 180) / Math.PI };
};

const STRID = BRIDGES.stridsbergsbron;
const KLAFF = BRIDGES.klaffbron;
const SYD_BRG = 212;
const START_POS = { lat: 58.29730356618855, lon: 12.299740243168928 }; // 517 m norr om bron

describe('U40/N4 A+B: analysatorn', () => {
  const T = 1_800_000_000_000;
  let analyzer;
  beforeEach(() => {
    analyzer = new GPSJumpAnalyzer(makeLogger());
  });
  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  const old = (over = {}) => ({
    ...START_POS,
    sog: 5.2,
    _rawPositionSog: 5.2,
    cog: 208.9,
    _rawPositionCog: 208.9,
    timestamp: T,
    fixTs: T,
    fixFeed: 'aisstream',
    ...over,
  });
  /** Analysera en fix `dtS` s efter startfixen på `pos`, med sog och kurs. */
  const analysera = (pos, { dtS = 200, sog = 0, cog = 164.1 } = {}, oldOver = {}) => {
    const t = T + dtS * 1000;
    Date.now = () => t;
    const o = old(oldOver);
    return analyzer.analyzeMovement('1', pos, { lat: o.lat, lon: o.lon }, {
      cog, sog, timestamp: t, fixTs: t, fixFeed: 'aisstream',
    }, o);
  };
  const STOPP = dest(STRID, SYD_BRG, 120);

  test('KÄRNAN: transit 5,2 kn → stopp 120 m bortom bron på 200 s blir osäkert, inte GPS-hopp (rött före N4)', () => {
    const r = analysera(STOPP);
    expect(r.action).toBe('accept_with_caution');
    expect(r.reason).toBe('stop_after_transit');
    expect(r.isGPSJump).toBe(false);
  });

  test('FÖRUTSÄTTNING: utan stoppvillkoren är samma geometri likely_gps_error (fart 0,6 kn på fixen)', () => {
    const r = analysera(STOPP, { sog: 0.6 });
    expect(r).toMatchObject({ action: 'gps_jump_detected', reason: 'likely_gps_error', isGPSJump: true });
  });

  test('MOTFALL kajliggare: startfix 0,3 kn ⇒ fortfarande GPS-hopp', () => {
    const r = analysera(STOPP, {}, { sog: 0.3, _rawPositionSog: 0.3 });
    expect(r).toMatchObject({ action: 'gps_jump_detected', reason: 'likely_gps_error' });
  });

  test('MOTFALL hopp längre än färden: startfix 1,0 kn (hinner 206 m) ⇒ fortfarande GPS-hopp', () => {
    const r = analysera(STOPP, {}, { sog: 1.0, _rawPositionSog: 1.0 });
    expect(r).toMatchObject({ action: 'gps_jump_detected', reason: 'likely_gps_error' });
  });

  test('MOTFALL bäringen > 45° från startkursen ⇒ fortfarande GPS-hopp', () => {
    // Startkurs 160° mot förflyttningens ~215°; stillakursen 150° (10° ändring)
    const r = analysera(STOPP, { cog: 150 }, { cog: 160, _rawPositionCog: 160 });
    expect(r).toMatchObject({ action: 'gps_jump_detected', reason: 'likely_gps_error' });
  });

  test('MOTFALL osäker eller hoppflaggad startfix ⇒ fortfarande GPS-hopp', () => {
    expect(analysera(STOPP, {}, { _gpsJumpDetected: true }).reason).toBe('likely_gps_error');
    expect(analysera(STOPP, {}, { _positionUncertain: true }).reason).toBe('likely_gps_error');
  });

  test('MOTFALL fysiskt omöjligt (F64): 666 m på 30 s med sog 0 ⇒ fortfarande physically_impossible_movement', () => {
    const r = analysera(STOPP, { dtS: 30 });
    expect(r).toMatchObject({ action: 'gps_jump_detected', reason: 'physically_impossible_movement' });
  });

  test('MOTFALL jitterbandet: stopp 55 m bortom brolinjen ⇒ fortfarande GPS-hopp', () => {
    const r = analysera(dest(STRID, SYD_BRG, 55), { dtS: 115 });
    expect(r).toMatchObject({ action: 'gps_jump_detected', reason: 'likely_gps_error' });
  });

  test('MOTFALL okänd fart på fixen (sog null) ⇒ ingen stoppklassning', () => {
    const r = analysera(STOPP, { sog: null });
    expect(r.reason).not.toBe('stop_after_transit');
  });

  test('REGELN är densamma som stillagrindens (stopExplainedByPriorTransit)', () => {
    const t = T + 200000;
    const cur = {
      ...STOPP, fixTs: t, fixFeed: 'aisstream', timestamp: t,
    };
    expect(GPSJumpAnalyzer.stopExplainedByPriorTransit(cur, old())).toBe(true);
    expect(GPSJumpAnalyzer.stopExplainedByPriorTransit(cur, old({ sog: 1.0, _rawPositionSog: 1.0 }))).toBe(false);
    expect(GPSJumpAnalyzer.stopExplainedByPriorTransit(cur, old({ cog: 150, _rawPositionCog: 150 }))).toBe(false);
  });
});

describe('U40/N4 C: riktiga pipelinen', () => {
  const liveServices = [];
  let nu;
  const T0 = 1_788_872_088_328;

  const bygg = () => {
    const logger = makeLogger();
    const coordinator = new SystemCoordinator(logger);
    const gate = new GPSJumpGateService(logger, coordinator);
    const svc = new VesselDataService(logger, new BridgeRegistry(), coordinator);
    svc.app = {
      gpsJumpGateService: gate,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    liveServices.push(svc);
    return { svc, gate };
  };

  beforeEach(() => {
    nu = T0;
    Date.now = () => nu;
    global.__TEST_MODE__ = true;
  });
  afterEach(() => {
    while (liveServices.length > 0) {
      try {
        liveServices.pop().clearAllTimers();
      } catch (_) { /* tomt */ }
    }
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
    jest.clearAllMocks();
  });

  const fix = (svc, mmsi, rad) => {
    nu = T0 + rad.s * 1000;
    svc.updateVessel(mmsi, {
      mmsi, lat: rad.lat, lon: rad.lon, sog: rad.sog, cog: rad.cog, name: 'N4-PROV', fixFeed: 'aisstream', fixTs: nu,
    });
    return svc.vessels.get(mmsi);
  };
  // Reprots transit (värld 9530) fram till sista fixen före glappet
  const TRANSIT = [
    {
      s: 0, lat: 58.320793347921025, lon: 12.323650082424036, sog: 5.8, cog: 193.9,
    },
    {
      s: 210, lat: 58.315415581915154, lon: 12.320415502545119, sog: 5.8, cog: 182.7,
    },
    {
      s: 837, lat: 58.30231346729976, lon: 12.30536142141084, sog: 5.1, cog: 215.4,
    },
    {
      s: 908, lat: 58.30094709498066, lon: 12.303531016524694, sog: 4.9, cog: 212,
    },
    {
      s: 1026, lat: 58.298501979229485, lon: 12.300984688229653, sog: 5.1, cog: 200.3,
    },
    {
      s: 1086, ...START_POS, sog: 5.2, cog: 208.9,
    },
  ];
  const transit = (svc, mmsi) => TRANSIT.forEach((r) => fix(svc, mmsi, r));

  test('KÄRNAN: stopp 120 m bortom Stridsbergsbron efter 200 s bokför passagen på stillafixen (rött före N4)', () => {
    const { svc, gate } = bygg();
    const MMSI = '265994001';
    transit(svc, MMSI);
    expect(svc.vessels.get(MMSI).targetBridge).toBe('Stridsbergsbron');
    const efter = fix(svc, MMSI, {
      s: 1086 + 200, ...dest(STRID, SYD_BRG, 120), sog: 0, cog: 164.1,
    });
    expect(efter._gpsJumpDetected).toBeFalsy();
    expect(efter._positionAnalysis.reason).toBe('stop_after_transit');
    expect(efter.passedBridges || []).toContain('Stridsbergsbron');
    expect((gate._candidatePassages.get(MMSI) || []).map((k) => k.bridgeName)).not.toContain('Stridsbergsbron');
  });

  // Jitterbandet gäller bara broar som segmentet KORSAT. Här ligger stillafixen
  // 200 m bortom Stridsbergsbron men 57 m FÖRE Järnvägsbron (inte korsad).
  test('stopp 200 m bortom Stridsbergsbron, 57 m före Järnvägsbron ⇒ Stridsbergsbron bokförs direkt (rött före N4)', () => {
    const { svc } = bygg();
    const MMSI = '265994005';
    TRANSIT.forEach((r, i) => fix(svc, MMSI, i === TRANSIT.length - 1 ? { ...r, sog: 7 } : r));
    // 718 m på 120 s (11,6 kn snitt); 7 kn × 120 s × 2 = 864 m räcker.
    const efter = fix(svc, MMSI, {
      s: 1086 + 120, ...dest(STRID, SYD_BRG, 200), sog: 0, cog: 164.1,
    });
    expect(efter._positionAnalysis.reason).toBe('stop_after_transit');
    expect(efter.passedBridges || []).toContain('Stridsbergsbron');
    expect(efter.passedBridges || []).not.toContain('Järnvägsbron');
  });

  // Inom jitterbandet kan ett brusprov hos en båt som stannat strax FÖRE bron
  // se ut exakt som ett stopp strax bortom. Där döms fixen som förut (hopp),
  // och nästa fix mäts från den rena startpositionen: ingen falsk passage.
  test('MOTFALL: stillafixen 55 m bortom linjen (jitterbandet) ⇒ GPS-hopp som förut, ingen passage', () => {
    const { svc, gate } = bygg();
    const MMSI = '265994002';
    transit(svc, MMSI);
    // 572 m på 115 s (5,2 × 115 × 2 = 615 m ≥ 572, snitt 9,7 kn > 5).
    const efter = fix(svc, MMSI, {
      s: 1086 + 115, ...dest(STRID, SYD_BRG, 55), sog: 0, cog: 164.1,
    });
    expect(efter._gpsJumpDetected).toBe(true);
    expect(efter._positionAnalysis.reason).toBe('likely_gps_error');
    expect(efter.passedBridges || []).not.toContain('Stridsbergsbron');
    expect((gate._candidatePassages.get(MMSI) || []).map((k) => k.bridgeName)).toContain('Stridsbergsbron');
    // Båten ligger i själva verket 30 m FÖRE bron: nästa fix bokför ingen passage
    const sann = fix(svc, MMSI, {
      s: 1086 + 115 + 180, ...dest(STRID, SYD_BRG + 180, 30), sog: 0, cog: 164.1,
    });
    expect(sann.passedBridges || []).not.toContain('Stridsbergsbron');
  });

  test('MOTFALL hopp längre än färden: transit 1,0 kn, samma stopp ⇒ GPS-hopp, ingen passage', () => {
    const { svc } = bygg();
    const MMSI = '265994003';
    TRANSIT.forEach((r, i) => fix(svc, MMSI, i === TRANSIT.length - 1 ? { ...r, sog: 1.0 } : r));
    const efter = fix(svc, MMSI, {
      s: 1086 + 200, ...dest(STRID, SYD_BRG, 120), sog: 0, cog: 164.1,
    });
    expect(efter._gpsJumpDetected).toBe(true);
    expect(efter.passedBridges || []).not.toContain('Stridsbergsbron');
  });

  test('MOTFALL kajliggare: still 12 min vid Klaffbron, brusprov 600 m norrut på 90 s ⇒ GPS-hopp, ingen passage', () => {
    const { svc } = bygg();
    const MMSI = '265994004';
    const punkt = (m) => ({ lat: KLAFF.lat + m / 111320, lon: KLAFF.lon });
    [-400, -200, -70].forEach((m, i) => fix(svc, MMSI, {
      s: i * 60, ...punkt(m), sog: 5.0, cog: 10,
    }));
    for (let i = 1; i <= 4; i++) {
      fix(svc, MMSI, {
        s: 120 + i * 180, ...punkt(-70), sog: 0, cog: 10,
      });
    }
    // 600 m rakt norrut på 120 s (9,7 kn snitt), sog 0, kurs 50° (40° ändring,
    // 50° fel mot förflyttningen): poäng under 0,4.
    const efter = fix(svc, MMSI, {
      s: 120 + 4 * 180 + 120, ...punkt(530), sog: 0, cog: 50,
    });
    expect(efter._gpsJumpDetected).toBe(true);
    expect(efter.passedBridges || []).not.toContain('Klaffbron');
  });
});
