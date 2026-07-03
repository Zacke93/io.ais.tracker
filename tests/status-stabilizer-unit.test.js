'use strict';

const StatusStabilizer = require('../lib/services/StatusStabilizer');

/**
 * Enhetstester för StatusStabilizer.
 *
 * Testar hysteres/utjämning av statusövergångar:
 *  - GPS-hopp: föregående status hålls kvar i 30 s-fönstret
 *  - osäker position: kräver 2 konsekutiva samstämmiga avläsningar
 *  - flimmerdetektering: dämpning mot vanligaste status i senaste 5 poster
 *  - konfidensberäkning (multiplikatorer för GPS-hopp, låg fart, långt avstånd)
 *  - historikretention (5 min), cleanup (1 h) och removeVessel
 *
 * OBS: I produktion anropas stabilizeStatus ENDAST när gpsJumpDetected eller
 * positionUncertain är satt (StatusService rad ~250) — flimmergrenen nås alltså
 * bara vid anrop utan dessa flaggor. Testerna täcker ändå hela kontraktet.
 */
describe('StatusStabilizer – hysteres och statusstabilisering', () => {
  let stabilizer;
  let mockNow;
  const realDateNow = Date.now;

  const logger = {
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const MMSI = '265001234';

  /** Skapar ett minimalt vessel-objekt (status = nuvarande status i systemet) */
  function makeVessel(status, overrides = {}) {
    return {
      mmsi: MMSI,
      status,
      sog: 5.0,
      _distanceToNearest: 200,
      ...overrides,
    };
  }

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 6, 1, 12, 0, 0).getTime();
    Date.now = () => mockNow;
    stabilizer = new StatusStabilizer(logger);
  });

  afterEach(() => {
    Date.now = realDateNow;
    delete global.__TEST_MODE__;
  });

  // -------------------------------------------------------------------
  // Normalfall (ingen GPS-osäkerhet)
  // -------------------------------------------------------------------

  describe('normalfall utan positionsosäkerhet', () => {
    test('första avläsningen accepteras direkt med hög konfidens', () => {
      // OBS: "no_history"-grenen i _applyStabilizationLogic är död kod —
      // proposed status pushas till historiken FÖRE analysen, så recentEntries
      // är aldrig tom. Första anropet går därför via normal_operation.
      const result = stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('en-route'), null);

      expect(result.status).toBe('en-route');
      expect(result.reason).toBe('normal_operation');
      expect(result.confidence).toBe('high');
      expect(result.stabilized).toBe(false);
    });

    test('stabil status utan flimmer accepteras även efter flera avläsningar', () => {
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      const result = stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);

      expect(result.status).toBe('waiting');
      expect(result.reason).toBe('normal_operation');
      expect(result.stabilized).toBe(false);
    });

    test('låg fart (< 0.5 kn) sänker konfidensen till medium', () => {
      const result = stabilizer.stabilizeStatus(
        MMSI, 'waiting', makeVessel('waiting', { sog: 0.3 }), null,
      );

      expect(result.confidence).toBe('medium'); // 0.8 <= HIGH_CONFIDENCE_THRESHOLD
    });
  });

  // -------------------------------------------------------------------
  // Konfidensberäkning (avläses via historikposten)
  // -------------------------------------------------------------------

  describe('konfidensberäkning', () => {
    /** Hämtar konfidensen från senaste historikposten */
    function lastConfidence() {
      const seq = stabilizer.statusHistory.get(MMSI).statusSequence;
      return seq[seq.length - 1].confidence;
    }

    test('GPS-hopp ger konfidens 0.3', () => {
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), { gpsJumpDetected: true });
      expect(lastConfidence()).toBeCloseTo(0.3);
    });

    test('osäker position ger konfidens 0.7', () => {
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), { positionUncertain: true });
      expect(lastConfidence()).toBeCloseTo(0.7);
    });

    test('långt avstånd till närmaste bro (> 1000 m) ger konfidens 0.9', () => {
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('en-route', { _distanceToNearest: 1500 }), null);
      expect(lastConfidence()).toBeCloseTo(0.9);
    });

    test('kombinerade faktorer multipliceras (hopp + låg fart + långt avstånd = 0.216)', () => {
      stabilizer.stabilizeStatus(
        MMSI, 'en-route',
        makeVessel('en-route', { sog: 0.2, _distanceToNearest: 2000 }),
        { gpsJumpDetected: true },
      );
      expect(lastConfidence()).toBeCloseTo(0.3 * 0.8 * 0.9);
    });
  });

  // -------------------------------------------------------------------
  // GPS-hopp: 30 sekunders stabiliseringsfönster
  // -------------------------------------------------------------------

  describe('GPS-hopp-stabilisering (30 s-fönster)', () => {
    test('föregående status hålls kvar direkt efter GPS-hopp', () => {
      const result = stabilizer.stabilizeStatus(
        MMSI, 'en-route', makeVessel('waiting'), { gpsJumpDetected: true },
      );

      expect(result.status).toBe('waiting'); // behåller föregående
      expect(result.reason).toBe('gps_jump_stabilization');
      expect(result.stabilized).toBe(true);
      expect(result.stabilizationRemaining).toBe(30 * 1000);
    });

    test('fönstret räknar ned: 10 s in i stabiliseringen återstår 20 s', () => {
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), { gpsJumpDetected: true });
      mockNow += 10 * 1000;

      const result = stabilizer.stabilizeStatus(
        MMSI, 'en-route', makeVessel('waiting'), { gpsJumpDetected: true },
      );

      expect(result.status).toBe('waiting');
      expect(result.stabilizationRemaining).toBe(20 * 1000);
    });

    test('efter 30 s släpps stabiliseringen och föreslagen status accepteras', () => {
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), { gpsJumpDetected: true });
      mockNow += 31 * 1000;

      const result = stabilizer.stabilizeStatus(
        MMSI, 'en-route', makeVessel('waiting'), { gpsJumpDetected: true },
      );

      expect(result.status).toBe('en-route');
      expect(result.reason).toBe('gps_jump_resolved');
      expect(result.confidence).toBe('low');
      expect(result.stabilized).toBe(false);
    });

    test('GPS-hopp utan statusändring passerar direkt (gps_jump_resolved)', () => {
      const result = stabilizer.stabilizeStatus(
        MMSI, 'waiting', makeVessel('waiting'), { gpsJumpDetected: true },
      );

      expect(result.status).toBe('waiting');
      expect(result.reason).toBe('gps_jump_resolved');
      expect(result.stabilized).toBe(false);
    });

    test('GPS-hopp utan föregående status (ny båt) accepterar föreslagen status', () => {
      const result = stabilizer.stabilizeStatus(
        MMSI, 'approaching', makeVessel(undefined), { gpsJumpDetected: true },
      );

      expect(result.status).toBe('approaching');
      expect(result.reason).toBe('gps_jump_resolved');
    });

    test('KÄND ANOMALI: stabiliseringsfönstret återstartas INTE av ett nytt GPS-hopp om flaggan aldrig återställdes', () => {
      // Scenario: hopp 1 startar fönstret; en mellanliggande avläsning där
      // proposed == previous lämnar stabilizationActive=true utan att röra
      // starttiden. Ett NYTT hopp 5 min senare får då INGEN stabilisering
      // eftersom det gamla fönstret redan "gått ut". Testet låser nuvarande
      // beteende — rapporterad anomali, fixa ej här.
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), { gpsJumpDetected: true });
      mockNow += 10 * 1000;
      // Avläsning där proposed == previous: lämnar flaggan aktiv
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), { gpsJumpDetected: true });
      mockNow += 5 * 60 * 1000;

      // Nytt GPS-hopp med statusändring — borde rimligen stabiliseras, men gör det inte
      const result = stabilizer.stabilizeStatus(
        MMSI, 'en-route', makeVessel('waiting'), { gpsJumpDetected: true },
      );

      expect(result.status).toBe('en-route');
      expect(result.reason).toBe('gps_jump_resolved');
      expect(result.stabilized).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Osäker position: kräver 2 samstämmiga avläsningar
  // -------------------------------------------------------------------

  describe('osäker position (konsistenskrav)', () => {
    test('första avvikande avläsningen hålls tillbaka', () => {
      const result = stabilizer.stabilizeStatus(
        MMSI, 'en-route', makeVessel('waiting'), { positionUncertain: true },
      );

      expect(result.status).toBe('waiting'); // behåller föregående
      expect(result.reason).toBe('uncertain_position_consistency');
      expect(result.stabilized).toBe(true);
    });

    test('andra samstämmiga avläsningen släpper igenom statusändringen', () => {
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), { positionUncertain: true });
      mockNow += 5 * 1000;

      const result = stabilizer.stabilizeStatus(
        MMSI, 'en-route', makeVessel('waiting'), { positionUncertain: true },
      );

      expect(result.status).toBe('en-route');
      expect(result.reason).toBe('uncertain_position_accepted');
      expect(result.stabilized).toBe(false);
    });

    test('osäker position utan statusändring accepteras direkt', () => {
      const result = stabilizer.stabilizeStatus(
        MMSI, 'waiting', makeVessel('waiting'), { positionUncertain: true },
      );

      expect(result.status).toBe('waiting');
      expect(result.reason).toBe('uncertain_position_accepted');
      expect(result.stabilized).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Flimmerdetektering och dämpning
  // -------------------------------------------------------------------

  describe('flimmerdetektering', () => {
    test('växlande status dämpas till vanligaste status i senaste 5 poster', () => {
      // Historik: waiting, waiting, en-route, waiting → föreslå en-route
      // Senaste 5 (inkl. nya): waiting×3, en-route×2 → dämpa till waiting
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), null);
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);

      const result = stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), null);

      expect(result.status).toBe('waiting');
      expect(result.reason).toBe('flickering_damped');
      expect(result.stabilized).toBe(true);
    });

    test('flimmer som redan konvergerat mot föreslagen status släpps igenom (flickering_resolved)', () => {
      // Historik: waiting, en-route → föreslå waiting.
      // Senaste 3 = [waiting, en-route, waiting] → flimmer, men vanligaste
      // status (waiting) == föreslagen → resolved utan dämpning.
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), null);

      const result = stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);

      expect(result.status).toBe('waiting');
      expect(result.reason).toBe('flickering_resolved');
      expect(result.stabilized).toBe(false);
    });

    test('KÄND ANOMALI: en enda legitim statusändring klassas som flimmer efter 3 avläsningar', () => {
      // _detectStatusFlickering kräver bara ≥2 unika statusar i senaste 3
      // poster — en helt normal övergång waiting→en-route→en-route räknas
      // alltså som "flimmer" (men släpps igenom som resolved eftersom
      // en-route är vanligast i senaste 5). I produktion nås grenen dock
      // bara vid anrop utan GPS-flaggor. Testet låser nuvarande beteende.
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), null);

      const result = stabilizer.stabilizeStatus(MMSI, 'en-route', makeVessel('waiting'), null);

      expect(result.reason).toBe('flickering_resolved'); // inte normal_operation
      expect(result.status).toBe('en-route');
    });
  });

  // -------------------------------------------------------------------
  // Historikretention och städning
  // -------------------------------------------------------------------

  describe('historikretention och städning', () => {
    test('poster äldre än 5 minuter rensas ur statushistoriken', () => {
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      mockNow += 6 * 60 * 1000; // 6 min senare

      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);

      const seq = stabilizer.statusHistory.get(MMSI).statusSequence;
      expect(seq).toHaveLength(1); // bara den färska posten kvar
    });

    test('cleanup tar bort båtar vars senaste post är äldre än 1 timme', () => {
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      mockNow += 61 * 60 * 1000; // 61 min senare
      stabilizer.stabilizeStatus('265009999', 'en-route', makeVessel('en-route', { mmsi: '265009999' }), null);

      stabilizer.cleanup();

      expect(stabilizer.statusHistory.has(MMSI)).toBe(false);
      expect(stabilizer.statusHistory.has('265009999')).toBe(true);
    });

    test('cleanup tar bort båtar med tom statussekvens', () => {
      stabilizer.statusHistory.set(MMSI, {
        statusSequence: [], lastStableStatus: null, lastStableTime: null, stabilizationActive: false,
      });

      stabilizer.cleanup();

      expect(stabilizer.statusHistory.has(MMSI)).toBe(false);
    });

    test('removeVessel tar bort en specifik båts historik', () => {
      stabilizer.stabilizeStatus(MMSI, 'waiting', makeVessel('waiting'), null);
      stabilizer.removeVessel(MMSI);

      expect(stabilizer.statusHistory.has(MMSI)).toBe(false);
    });

    test('removeVessel för okänd båt kastar inte', () => {
      expect(() => stabilizer.removeVessel('999999999')).not.toThrow();
    });
  });
});
