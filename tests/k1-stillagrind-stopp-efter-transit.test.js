'use strict';

/**
 * K1 (rättningsomgång 3, 2026-11-16) — STILLAGRINDEN (S1) OCH EN BÅT SOM
 * STANNAR STRAX BORTOM BRON. Nattjaktens F16/F17, värld 9530.
 *
 * SITUATIONEN. NORDVIND går söderut i 5,2 kn, 517 m norr om Stridsbergsbron.
 * Nästa fix kommer 327 s senare: 165 m bortom bron, i kön före Järnvägsbron,
 * sog 0 och en stillakurs 44,8° från den gamla. GPSJumpAnalyzer dömer 683 m
 * som `uncertain_movement` (stillakursen pekar 51° fel mot förflyttningen),
 * SystemCoordinator ger nivån 'moderate', och S1 spärrade passagen tills nästa
 * fix 16 min senare: "närmar sig Stridsbergsbron" två minuter EFTER passagen,
 * brotexten pekade på den passerade bron och passagenotisen kom aldrig.
 *
 * RÄTTNINGEN (GPSJumpGateService._stopExplainedByPriorTransit): S1 spärrar
 * inte när segmentets startfix är ren med sog ≥ MOVEMENT_PROOF_SOG_KN, när
 * förflyttningen ryms i startfartens sträcka × 2,0, när bäringen ligger inom
 * 45° från startkursen och när stillafixen ligger mer än
 * UNDER_BRIDGE_CROSS_PROOF_JITTER_M från brons linje.
 *
 * Sviten kör den RIKTIGA pipelinen (VesselDataService.updateVessel med riktig
 * SystemCoordinator, GPSJumpAnalyzer och GPSJumpGateService) och låser:
 *   A. Fältlika fallet (reprots egna fixar): passagen bokförs på stillafixen.
 *   B. Systerställena: norrut genom Klaffbron och söderut genom mellanbron
 *      Järnvägsbron.
 *   C. Motfallen där S1 ska stå kvar: kajliggarens brusprov med sog-brus på
 *      startfixen, stopp FÖRE bron med brusprov strax bortom linjen, ett hopp
 *      bakåt och ett hopp längre än färden förklarar.
 *   D. Predikatet villkor för villkor.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const { BRIDGES, MOORING_DETECTION, UNDER_BRIDGE_CROSS_PROOF_JITTER_M } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const R = 6371000;

const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Punkt `d` meter från `p` i bäringen `brg` (storcirkel). */
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
const JVB = BRIDGES.jarnvagsbron;
const KLAFF = BRIDGES.klaffbron;
// Farledens bäring söderut mellan Stridsbergsbron och Järnvägsbron
const SYD_BRG = 212;

// Reprots egna fixar (värld 9530, aisstream, klass B), tid i s från första fixen.
const F16_RADER = [
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
    s: 1086, lat: 58.29730356618855, lon: 12.299740243168928, sog: 5.2, cog: 208.9,
  },
];
const F16_STILLA = {
  s: 1413, lat: 58.29230927928874, lon: 12.292930125369432, sog: 0, cog: 164.1,
};

describe('K1: stillafix efter transit genom bron (riktiga pipelinen)', () => {
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
    return {
      svc, gate, coordinator, logger,
    };
  };

  beforeEach(() => {
    nu = T0;
    Date.now = () => nu;
    global.__TEST_MODE__ = true;
  });

  afterEach(() => {
    while (liveServices.length > 0) {
      const svc = liveServices.pop();
      try {
        svc.clearAllTimers();
      } catch (_) { /* tomt */ }
    }
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
    jest.clearAllMocks();
  });

  const fix = (svc, mmsi, rad) => {
    nu = T0 + rad.s * 1000;
    svc.updateVessel(mmsi, {
      mmsi,
      lat: rad.lat,
      lon: rad.lon,
      sog: rad.sog,
      cog: rad.cog,
      name: 'K1-PROV',
      fixFeed: 'aisstream',
      fixTs: nu,
    });
    return svc.vessels.get(mmsi);
  };

  /** Kör reprots transit fram till sista fixen före glappet. */
  const transitTillGlappet = (svc, mmsi, sistaSog = 5.2) => {
    let v;
    F16_RADER.forEach((rad, i) => {
      v = fix(svc, mmsi, i === F16_RADER.length - 1 ? { ...rad, sog: sistaSog } : rad);
    });
    return v;
  };

  describe('A. Fältlika fallet (värld 9530)', () => {
    const MMSI = '265669197';

    test('FÖRUTSÄTTNINGARNA: målbro Stridsbergsbron, och stillafixen blir osäker med moderate', () => {
      const { svc, coordinator } = bygg();
      const fore = transitTillGlappet(svc, MMSI);
      expect(fore.targetBridge).toBe('Stridsbergsbron');
      const efter = fix(svc, MMSI, F16_STILLA);
      expect(efter._positionUncertain).toBe(true);
      expect(efter._positionAnalysis.reason).toBe('uncertain_movement');
      const c = coordinator.getCoordination(MMSI);
      expect(c.level).toBe('moderate');
      expect(c.protection).toBe(true);
      expect(efter.sog).toBeLessThan(MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN);
    });

    test('KÄRNAN: passagen av Stridsbergsbron bokförs på stillafixen (rött före K1)', () => {
      const { svc, gate } = bygg();
      transitTillGlappet(svc, MMSI);
      const efter = fix(svc, MMSI, F16_STILLA);
      expect(efter.passedBridges || []).toContain('Stridsbergsbron');
      expect(efter.targetBridge).not.toBe('Stridsbergsbron');
      // Ingen kandidat ligger kvar och väntar på nästa fix
      const kandidater = gate._candidatePassages.get(MMSI) || [];
      expect(kandidater.map((k) => k.bridgeName)).not.toContain('Stridsbergsbron');
    });
  });

  describe('B. Systerställen', () => {
    test('NORRUT GENOM KLAFFBRON: stopp 150 m bortom bron bokför passagen direkt (rött före K1)', () => {
      const { svc } = bygg();
      const MMSI = '265991101';
      const punkt = (m) => ({ lat: KLAFF.lat + m / 111320, lon: KLAFF.lon });
      // Norrut i 5,2 kn med kurs 10° (förflyttningen går rakt norrut, 0°)
      [-1400, -1100, -800, -520].forEach((m, i) => {
        fix(svc, MMSI, {
          s: i * 60 + (m === -520 ? 50 : 0), ...punkt(m), sog: 5.2, cog: 10,
        });
      });
      const fore = svc.vessels.get(MMSI);
      expect(fore.targetBridge).toBe('Klaffbron');
      // 327 s senare: 150 m norr om bron, sog 0, stillakurs 54° (44° från 10°)
      const efter = fix(svc, MMSI, {
        s: 230 + 327, ...punkt(150), sog: 0, cog: 54,
      });
      expect(efter._positionUncertain).toBe(true);
      expect(efter.passedBridges || []).toContain('Klaffbron');
    });

    test('MELLANBRON JÄRNVÄGSBRON SÖDERUT: stopp 150 m bortom bron bokför mellanbropassagen direkt (rött före K1)', () => {
      const { svc } = bygg();
      const MMSI = '265991102';
      // Söderut mot Stridsbergsbron i 5,2 kn, kurs 205° (förflyttningen
      // ~212°). Sista fixen före glappet ligger 400 m norr om Järnvägsbron
      // (143 m norr om Stridsbergsbron); glappet spänner över båda broarna.
      const pos = (m) => dest(JVB, SYD_BRG + 180, m);
      [1300, 1000, 700, 400].forEach((m, i) => fix(svc, MMSI, {
        s: i * 112, ...pos(m), sog: 5.2, cog: 205,
      }));
      const fore = svc.vessels.get(MMSI);
      expect(fore.targetBridge).toBe('Stridsbergsbron');
      // 327 s senare: 150 m bortom Järnvägsbron, sog 0, stillakurs 161°
      const efter = fix(svc, MMSI, {
        s: 336 + 327, ...dest(JVB, SYD_BRG, 150), sog: 0, cog: 161,
      });
      expect(efter._positionUncertain).toBe(true);
      expect(efter.passedBridges || []).toEqual(expect.arrayContaining(['Stridsbergsbron', 'Järnvägsbron']));
    });
  });

  describe('C. Motfall: S1 står kvar', () => {
    // Geometrin själv bokför inte en stillafix 10–40 m bortom linjen i det här
    // segmentet (enhanced_line_crossing först från ~50 m); 55 m prövar alltså
    // just jitterbandet (villkor 4), där geometrin skulle ha bokfört.
    test('STOPP FÖRE BRON, BRUSPROV 55 m BORTOM LINJEN: ingen passage, bara kandidat', () => {
      const { svc, gate } = bygg();
      const MMSI = '265991201';
      transitTillGlappet(svc, MMSI);
      const efter = fix(svc, MMSI, {
        s: F16_STILLA.s, ...dest(STRID, SYD_BRG, 55), sog: 0, cog: 164.1,
      });
      expect(efter._positionUncertain).toBe(true);
      expect(efter._positionAnalysis.reason).toBe('uncertain_movement');
      expect(efter.passedBridges || []).not.toContain('Stridsbergsbron');
      const kandidater = gate._candidatePassages.get(MMSI) || [];
      expect(kandidater.map((k) => k.bridgeName)).toContain('Stridsbergsbron');
    });

    test('HOPP LÄNGRE ÄN FÄRDEN FÖRKLARAR: startfix 1,0 kn, 683 m på 327 s ⇒ spärrad', () => {
      const { svc, gate } = bygg();
      const MMSI = '265991202';
      transitTillGlappet(svc, MMSI, 1.0);
      const efter = fix(svc, MMSI, F16_STILLA);
      expect(efter._positionUncertain).toBe(true);
      expect(efter.passedBridges || []).not.toContain('Stridsbergsbron');
      const kandidater = gate._candidatePassages.get(MMSI) || [];
      expect(kandidater.map((k) => k.bridgeName)).toContain('Stridsbergsbron');
    });

    // S1:s eget kajliggarprov (169 m på 60 s) fångas sedan 2026-09-09 av
    // orimlighetsflaggan (medium_movement_speed_mismatch) innan S1 prövas. Här
    // är brusprovet > 500 m på en klass B-stillakadens (180 s), så analysen
    // blir uncertain_movement och det är S1 som håller emot.
    const kajliggare = (svc, mmsi, sistaStillaSog) => {
      const punkt = (m) => ({ lat: KLAFF.lat + m / 111320, lon: KLAFF.lon });
      [-400, -200, -70].forEach((m, i) => fix(svc, mmsi, {
        s: i * 60, ...punkt(m), sog: 5.0, cog: 0,
      }));
      for (let i = 1; i <= 4; i++) {
        fix(svc, mmsi, {
          s: 120 + i * 180, ...punkt(-70), sog: i === 4 ? sistaStillaSog : 0, cog: 0,
        });
      }
      // Brusprovet: 600 m rakt norrut på 180 s, sog 0, kurs 44° (6,5 kn i snitt)
      return fix(svc, mmsi, {
        s: 120 + 5 * 180, ...punkt(530), sog: 0, cog: 44,
      });
    };

    test('KAJLIGGARE, BRUSPROV 600 m ÖVER KLAFFBRON (startfix sog 0) ⇒ spärrad', () => {
      const { svc, gate } = bygg();
      const MMSI = '265991203';
      const efter = kajliggare(svc, MMSI, 0);
      expect(efter._positionAnalysis.reason).toBe('uncertain_movement');
      expect(efter.passedBridges || []).not.toContain('Klaffbron');
      const kandidater = gate._candidatePassages.get(MMSI) || [];
      expect(kandidater.map((k) => k.bridgeName)).toContain('Klaffbron');
    });

    test('KAJLIGGARE MED SOG-BRUS 0,6 kn PÅ STARTFIXEN, BRUSPROV 600 m ⇒ spärrad (villkor 2)', () => {
      const { svc, gate } = bygg();
      const MMSI = '265991204';
      const efter = kajliggare(svc, MMSI, 0.6);
      expect(efter._positionAnalysis.reason).toBe('uncertain_movement');
      expect(efter.passedBridges || []).not.toContain('Klaffbron');
      const kandidater = gate._candidatePassages.get(MMSI) || [];
      expect(kandidater.map((k) => k.bridgeName)).toContain('Klaffbron');
    });
  });
});

describe('K1: predikatet villkor för villkor', () => {
  const gates = [];
  const MODERATE = { level: 'moderate', protection: true };
  const bygg = () => {
    const gate = new GPSJumpGateService(makeLogger(), {
      getCoordination: jest.fn().mockReturnValue(MODERATE),
    });
    gates.push(gate);
    return gate;
  };
  afterEach(() => {
    while (gates.length > 0) gates.pop().destroy();
  });

  const T = 1_800_000_000_000;
  // F16-geometrin: start 517 m norr om Stridsbergsbron, stopp 165 m bortom.
  const startPos = dest(STRID, SYD_BRG + 180, 517);
  const stoppPos = dest(STRID, SYD_BRG, 165);
  const start = (over = {}) => ({
    ...startPos, sog: 5.2, cog: 209, fixTs: T, fixFeed: 'aisstream', timestamp: T, ...over,
  });
  const stopp = (over = {}) => ({
    mmsi: 1, ...stoppPos, sog: 0, fixTs: T + 327000, fixFeed: 'aisstream', timestamp: T + 327000, ...over,
  });
  const spärrar = (gate, vessel, segStart, bro = 'Stridsbergsbron') => gate
    .shouldBlockPassageDetection('1', vessel, bro, segStart);

  test('F16: transit, förklarad förflyttning, rätt bäring, bortom jitterbandet ⇒ spärrar INTE', () => {
    expect(spärrar(bygg(), stopp(), start())).toBe(false);
  });

  test('UTAN STARTFIX (äldre anrop) ⇒ spärrar som förut', () => {
    expect(spärrar(bygg(), stopp(), null)).toBe(true);
    expect(bygg().shouldBlockPassageDetection('1', stopp(), 'Stridsbergsbron')).toBe(true);
  });

  test('VILLKOR 1: startfix under MOVEMENT_PROOF_SOG_KN eller utan fart ⇒ spärrar', () => {
    const g = bygg();
    expect(spärrar(g, stopp(), start({ sog: MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN - 0.01 }))).toBe(true);
    expect(spärrar(g, stopp(), start({ sog: null }))).toBe(true);
    // Råfarten styr, inte det klistrande sog-fältet (positionSog)
    expect(spärrar(g, stopp(), start({ sog: 5.2, _rawPositionSog: null }))).toBe(true);
  });

  test('VILLKOR 1 ENSAMT: långt glapp där 0,4 kn hade räckt för sträckan ⇒ spärrar; 0,5 kn släpps', () => {
    const g = bygg();
    // Start 100 m före bron, stopp 165 m bortom (265 m) på 900 s:
    // 0,4 kn × 900 s × 2,0 = 370 m räcker för sträckan, men 0,4 < 0,5.
    const nara = dest(STRID, SYD_BRG + 180, 100);
    const lang = { fixTs: T + 900000, timestamp: T + 900000 };
    expect(spärrar(g, stopp(lang), start({ ...nara, sog: 0.4 }))).toBe(true);
    expect(spärrar(g, stopp(lang), start({ ...nara, sog: MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN }))).toBe(false);
  });

  test('VILLKOR 1: osäker eller hoppflaggad startfix ⇒ spärrar', () => {
    const g = bygg();
    expect(spärrar(g, stopp(), start({ _positionUncertain: true }))).toBe(true);
    expect(spärrar(g, stopp(), start({ _gpsJumpDetected: true }))).toBe(true);
  });

  test('VILLKOR 2: förflyttningen över startfart × dt × 2,0 ⇒ spärrar; gränsen exakt', () => {
    const g = bygg();
    // 683 m på 327 s kräver ≥ 683 / (2 × 327 s) = 2,03 kn
    expect(spärrar(g, stopp(), start({ sog: 2.0 }))).toBe(true);
    expect(spärrar(g, stopp(), start({ sog: 2.1 }))).toBe(false);
    // Kort glapp: 683 m på 60 s kräver 11 kn
    expect(spärrar(g, stopp({ fixTs: T + 60000, timestamp: T + 60000 }), start())).toBe(true);
    // Negativ eller noll fixseparation ⇒ spärrar
    expect(spärrar(g, stopp({ fixTs: T, timestamp: T }), start())).toBe(true);
  });

  test('VILLKOR 2: utan fixtid räknas mottagningstiden (som analysatorn)', () => {
    const g = bygg();
    expect(spärrar(g, stopp({ fixTs: null, fixFeed: null }), start({ fixTs: null, fixFeed: null }))).toBe(false);
    expect(spärrar(g, stopp({ fixTs: null, fixFeed: null, timestamp: T + 60000 }), start({ fixTs: null, fixFeed: null }))).toBe(true);
  });

  test('VILLKOR 3: bäringen > 45° från startkursen ⇒ spärrar; okänd startkurs prövas inte', () => {
    const g = bygg();
    // Förflyttningens bäring är ~212°
    expect(spärrar(g, stopp(), start({ cog: 212 + 50 }))).toBe(true);
    expect(spärrar(g, stopp(), start({ cog: 212 - 50 }))).toBe(true);
    expect(spärrar(g, stopp(), start({ cog: 212 + 40 }))).toBe(false);
    expect(spärrar(g, stopp(), start({ cog: null }))).toBe(false);
    expect(spärrar(g, stopp(), start({ cog: 360 }))).toBe(false);
    // Råkursen styr när den finns
    expect(spärrar(g, stopp(), start({ cog: 212, _rawPositionCog: 32 }))).toBe(true);
  });

  test('VILLKOR 4: stillafix inom jitterbandet från den prövade brons linje ⇒ spärrar', () => {
    const g = bygg();
    const nara = dest(STRID, SYD_BRG, UNDER_BRIDGE_CROSS_PROOF_JITTER_M - 15);
    const bortom = dest(STRID, SYD_BRG, UNDER_BRIDGE_CROSS_PROOF_JITTER_M + 15);
    expect(spärrar(g, stopp(nara), start())).toBe(true);
    expect(spärrar(g, stopp(bortom), start())).toBe(false);
    // Bandet gäller per bro: samma fix prövad mot Klaffbron (långt bort) spärrar inte
    expect(spärrar(g, stopp(nara), start(), 'Klaffbron')).toBe(false);
    // Okänd bro ⇒ spärrar som förut
    expect(spärrar(g, stopp(), start(), 'Okändbron')).toBe(true);
  });

  test('RÖRLIG BÅT och andra nivåer påverkas inte (S1:s avgränsningar oförändrade)', () => {
    const g = bygg();
    expect(spärrar(g, stopp({ sog: 0.6 }), start({ sog: 0 }))).toBe(false);
    const light = new GPSJumpGateService(makeLogger(), {
      getCoordination: jest.fn().mockReturnValue({ level: 'light', protection: true }),
    });
    gates.push(light);
    expect(spärrar(light, stopp(), start({ sog: 0 }))).toBe(false);
  });

  test('ORIMLIGHETSFLAGGAN (needsPassageConfirmation) går före och påverkas inte', () => {
    const g = bygg();
    expect(spärrar(g, stopp({ _gpsJumpDetected: true }), start())).toBe(true);
    expect(spärrar(g, stopp({
      _positionUncertain: true, _positionAnalysis: { reason: 'medium_movement_speed_mismatch' },
    }), start())).toBe(true);
  });

  // K1-granskningen (L2): en återhämtningsstart (segmentets start när förra
  // fixen var GPS-hoppflaggad) ska bära den RENA fixens råkurs, inte den
  // osäkra fixens. Förut kom läget, tiden och farten från den rena fixen men
  // råkursen från det flaggade fartygsobjektet.
  describe('återhämtningsstart (passageSegmentStart)', () => {
    const REAL_NOW = Date.now;
    beforeEach(() => {
      Date.now = () => T + 327000;
    });
    afterEach(() => {
      Date.now = REAL_NOW;
    });

    const ren = (over = {}) => start({
      _rawPositionSog: 5.2, _rawPositionCog: 209, ...over,
    });
    // Den osäkra fixen: hoppflaggad, ett annat läge och kurs 120°.
    const flaggad = (renFix, over = {}) => ({
      ...dest(STRID, SYD_BRG + 180, 300),
      sog: 5.0,
      _rawPositionSog: 5.0,
      cog: 120,
      _rawPositionCog: 120,
      fixTs: T + 100000,
      fixFeed: 'aisstream',
      timestamp: T + 100000,
      _gpsJumpDetected: true,
      _passageRecoveryPosition: GPSJumpAnalyzer.passageRecoveryPosition(renFix),
      ...over,
    });

    test('RÅKURSEN KOMMER FRÅN DEN RENA FIXEN ⇒ villkor 3 prövas mot rätt kurs (rött före L2)', () => {
      const seg = GPSJumpAnalyzer.passageSegmentStart(flaggad(ren()));
      expect(seg.lat).toBeCloseTo(startPos.lat, 9);
      expect(seg._rawPositionCog).toBe(209);
      expect(spärrar(bygg(), stopp(), seg)).toBe(false);
    });

    test('den rena fixens kurs > 45° fel ⇒ spärrar, oavsett den osäkra fixens kurs', () => {
      const seg = GPSJumpAnalyzer.passageSegmentStart(flaggad(ren({ cog: 140, _rawPositionCog: 140 }), {
        cog: 212, _rawPositionCog: 212,
      }));
      expect(seg._rawPositionCog).toBe(140);
      expect(spärrar(bygg(), stopp(), seg)).toBe(true);
    });

    test('MOTFALL: kursen saknas på riktigt (båda fixarna) ⇒ villkor 3 prövas inte, som förut', () => {
      const seg = GPSJumpAnalyzer.passageSegmentStart(flaggad(ren({ cog: null, _rawPositionCog: null }), {
        cog: null, _rawPositionCog: null,
      }));
      expect(seg._rawPositionCog).toBeNull();
      expect(spärrar(bygg(), stopp(), seg)).toBe(false);
    });

    test('den rena fixen saknar kurs men den osäkra har en ⇒ kursen räknas som okänd', () => {
      const seg = GPSJumpAnalyzer.passageSegmentStart(flaggad(ren({ cog: null, _rawPositionCog: null })));
      expect(seg._rawPositionCog).toBeNull();
      expect(spärrar(bygg(), stopp(), seg)).toBe(false);
    });

    test('återhämtningspositionen (fixobjekt utan råfält) tar kursen ur cog', () => {
      const pos = GPSJumpAnalyzer.passageRecoveryPosition({
        ...startPos, sog: 5.2, cog: 205, timestamp: T,
      });
      expect(pos._rawPositionCog).toBe(205);
      expect(pos._rawPositionSog).toBe(5.2);
    });
  });
});
