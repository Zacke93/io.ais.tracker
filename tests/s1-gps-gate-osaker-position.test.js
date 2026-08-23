'use strict';

/**
 * S1 (systerställesrundan 2026-08-23) — PASSAGEGRINDEN SÅG INTE 'moderate'.
 *
 * MEKANISMEN. GPSJumpAnalyzer dömer 100–500 m skenbar förflyttning som
 * fysiskt orimlig till `accept_with_caution`; SystemCoordinator gör det till
 * koordinationsnivå 'moderate' med protection (uncertain_position), och
 * VesselDataService sätter _positionUncertain. Men GPSJumpGateService
 * blockerade bara 'enhanced'/'system_wide' (plus en aktiv gate, som armeras
 * enbart i gpsJumpDetected-grenen). En position appen SJÄLV just dömt osäker
 * kunde därför bära en målbropassage rakt genom trajektoriedetekteringen:
 * falsk passage, målet flyttas fram, brotexten ljuger i tiotals minuter och
 * den ÄKTA passagen bokförs sedan aldrig (bron är redan avbockad).
 *
 * FIXEN (snäv variant): blockera även 'moderate' med protection NÄR fartyget
 * har FINIT sog under MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN (0,5 kn). Under
 * rörelsebeviströskeln har båten per projektets doktrin inte rört sig, så
 * 100–500 m skenbar rörelse är brus. Rörliga båtar och den okända-fart-klassen
 * (sog null) rörs inte.
 *
 * SVITEN KÖR ALLT GENOM RIKTIGA PIPELINEN (VesselDataService.updateVessel med
 * riktig SystemCoordinator, riktig GPSJumpAnalyzer och riktig
 * GPSJumpGateService) och låser:
 *   1. RÖD PÅ HEAD: kajliggarens brusprov bokför en falsk målbropassage.
 *   2. Med fixen: ingen passage — men en KANDIDAT registreras (inget tappas).
 *   3. Tvåstegsbekräftelsen räddar en äkta passage ur kandidatläget.
 *   4. Den ÄKTA avfärden senare detekteras normalt (grinden är inte klistrig).
 *   5. Avgränsningarna: rörlig båt (sog ≥ 0,5) och okänd fart (sog null)
 *      blockeras INTE, och 'light'/'normal' rörs inte.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const { BRIDGES, MOORING_DETECTION } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const M_PER_DEG_LAT = 111320; // ~meter per latitudgrad vid Trollhättan

const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

describe('S1: osäker position (moderate) får inte bära en passage', () => {
  const liveServices = [];
  let nu;

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
    nu = 1_700_000_000_000;
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

  const MMSI = '265991001';
  const KLAFF = BRIDGES.klaffbron;
  const latVidMeter = (meterNorrOmBron) => KLAFF.lat + meterNorrOmBron / M_PER_DEG_LAT;

  const sampel = (svc, mmsi, meterNorrOmBron, sog) => {
    svc.updateVessel(mmsi, {
      mmsi,
      lat: latVidMeter(meterNorrOmBron),
      lon: KLAFF.lon,
      sog,
      cog: 0, // rak nordkurs hela scenariot — ingen manöverförklaring
      name: 'S1-PROV',
      fixFeed: 'aishub',
      fixTs: nu,
    });
    return svc.vessels.get(mmsi);
  };

  /**
   * Kajliggarscenariot ur rapportens repro: norrut i 5 kn till 70 m S om
   * Klaffbron (rörelsebevis + målbro), still i 12 min, sedan ETT brusprov
   * 169 m rakt norrut på 60 s (= 99 m N om bron, alltså över brolinjen).
   * 169 m på 60 s med sog 0 överstiger analyzerns realistiska tak (1 kn-golv,
   * 2× marginal ⇒ ~62 m) ⇒ accept_with_caution ⇒ moderate koordination.
   */
  const koerKajliggareMedBrusprov = (svc, mmsi = MMSI) => {
    sampel(svc, mmsi, -400, 5.0);
    nu += 60_000;
    sampel(svc, mmsi, -200, 5.0);
    nu += 60_000;
    const efterAnkomst = sampel(svc, mmsi, -70, 5.0);

    // Stilla vid kajen i 12 minuter
    for (let i = 0; i < 12; i++) {
      nu += 60_000;
      sampel(svc, mmsi, -70, 0);
    }

    // Brusprovet: 169 m rakt norrut på 60 s med sog 0
    nu += 60_000;
    const efterBrus = sampel(svc, mmsi, 99, 0);
    return { efterAnkomst, efterBrus };
  };

  test('FÖRUTSÄTTNINGARNA: målbro tilldelad och brusprovet ger moderate koordination', () => {
    const { svc, coordinator } = bygg();
    const { efterAnkomst, efterBrus } = koerKajliggareMedBrusprov(svc);

    // Utan målbro provar scenariot ingenting
    expect(efterAnkomst.targetBridge).toBe('Klaffbron');
    // Appen har SJÄLV dömt positionen osäker...
    expect(efterBrus._positionUncertain).toBe(true);
    // ...och koordinationen är exakt den nivå grinden inte såg
    const coordination = coordinator.getCoordination(MMSI);
    expect(coordination.level).toBe('moderate');
    expect(coordination.protection).toBe(true);
    // Farten är under rörelsebeviströskeln (fixens andra ben)
    expect(efterBrus.sog).toBeLessThan(MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN);
  });

  test('KÄRNAN: brusprovet bokför INGEN målbropassage (rött på HEAD)', () => {
    const { svc, gate } = bygg();
    const { efterBrus } = koerKajliggareMedBrusprov(svc);

    // Ingen falsk passage: målbron står kvar och Klaffbron är inte avbockad
    expect(efterBrus.passedBridges || []).not.toContain('Klaffbron');
    expect(efterBrus.targetBridge).toBe('Klaffbron');

    // ...men passagen är INTE kastad: den lever som kandidat
    const kandidater = gate._candidatePassages.get(MMSI) || [];
    expect(kandidater.map((k) => k.bridgeName)).toContain('Klaffbron');
  });

  test('INGET TAPPAS: tvåstegsbekräftelsen kan applicera kandidaten', () => {
    const { svc, gate } = bygg();
    koerKajliggareMedBrusprov(svc);

    // Stabil position 60 s senare (bekräftelseperioden är 5 s) — samma
    // punkt som kandidaten registrerades på ⇒ stabil ⇒ bekräftad.
    nu += 60_000;
    const vessel = svc.vessels.get(MMSI);
    const bekraftade = gate.confirmStableCandidates(MMSI, vessel);

    expect(bekraftade.map((b) => b.bridgeName)).toContain('Klaffbron');
  });

  test('ÄKTA AVFÄRD: passagen detekteras normalt när båten verkligen går', () => {
    const { svc } = bygg();
    koerKajliggareMedBrusprov(svc);

    // Tillbaka till kajen (brusprovet var en utflykt), sedan verklig avfärd
    nu += 60_000;
    const tillbakaVidKajen = sampel(svc, MMSI, -70, 0);
    // Bron får INTE vara avbockad här — på HEAD är den redan det, och då
    // ger den ÄKTA passagen nedan varken notis eller öppningsvarning.
    expect(tillbakaVidKajen.passedBridges || []).not.toContain('Klaffbron');
    nu += 60_000;
    sampel(svc, MMSI, -40, 4.0);
    nu += 60_000;
    const efterPassage = sampel(svc, MMSI, 120, 5.0);

    expect(efterPassage.passedBridges || []).toContain('Klaffbron');
  });
});

describe('S1: grindens avgränsningar (predikatet direkt)', () => {
  const gates = [];
  const bygg = (coordination) => {
    const gate = new GPSJumpGateService(makeLogger(), {
      getCoordination: jest.fn().mockReturnValue(coordination),
    });
    gates.push(gate);
    return gate;
  };

  afterEach(() => {
    while (gates.length > 0) gates.pop().destroy();
  });

  const MODERATE = { level: 'moderate', protection: true };

  test('moderate + protection + sog 0,4 kn ⇒ blockerar', () => {
    const gate = bygg(MODERATE);
    expect(gate.shouldBlockPassageDetection('1', { mmsi: 1, sog: 0.4 }, 'Klaffbron')).toBe(true);
  });

  test('RÖRLIG BÅT: moderate + sog 0,5 kn (tröskeln) ⇒ blockerar INTE', () => {
    const gate = bygg(MODERATE);
    expect(gate.shouldBlockPassageDetection('2', { mmsi: 2, sog: MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN }, 'Klaffbron')).toBe(false);
  });

  test('OKÄND FART: moderate + sog null/undefined/NaN ⇒ blockerar INTE', () => {
    const gate = bygg(MODERATE);
    expect(gate.shouldBlockPassageDetection('3', { mmsi: 3, sog: null }, 'Klaffbron')).toBe(false);
    expect(gate.shouldBlockPassageDetection('4', { mmsi: 4 }, 'Klaffbron')).toBe(false);
    expect(gate.shouldBlockPassageDetection('5', { mmsi: 5, sog: NaN }, 'Klaffbron')).toBe(false);
  });

  test('moderate UTAN protection ⇒ blockerar INTE', () => {
    const gate = bygg({ level: 'moderate', protection: false });
    expect(gate.shouldBlockPassageDetection('6', { mmsi: 6, sog: 0 }, 'Klaffbron')).toBe(false);
  });

  test('light/normal med sog 0 ⇒ blockerar INTE (bara moderate är nyheten)', () => {
    expect(bygg({ level: 'light', protection: true })
      .shouldBlockPassageDetection('7', { mmsi: 7, sog: 0 }, 'Klaffbron')).toBe(false);
    expect(bygg({ level: 'normal', protection: false })
      .shouldBlockPassageDetection('8', { mmsi: 8, sog: 0 }, 'Klaffbron')).toBe(false);
  });

  test('SYSTERSTÄLLET: fallbacken utan SystemCoordinator följer samma regel', () => {
    const gate = new GPSJumpGateService(makeLogger(), null);
    gates.push(gate);
    expect(gate.shouldBlockPassageDetection('9', { mmsi: 9, lastCoordinationLevel: 'moderate', sog: 0.2 }, 'Klaffbron')).toBe(true);
    expect(gate.shouldBlockPassageDetection('10', { mmsi: 10, lastCoordinationLevel: 'moderate', sog: 3 }, 'Klaffbron')).toBe(false);
    expect(gate.shouldBlockPassageDetection('11', { mmsi: 11, lastCoordinationLevel: 'light', sog: 0 }, 'Klaffbron')).toBe(false);
  });
});
