'use strict';

/**
 * Beteendetester för GPSJumpGateService — kompletterar gps-gate-candidate-retry
 * (F11-retryn) och helkodsgranskning-2026-07 (S-F1 sog-fixen) med de tidigare
 * otäckta vägarna:
 *  - gate-livscykeln: activateGate → blockering → timeout/manuell release
 *  - GPS-koordination via SystemCoordinator (enhanced/system_wide + fallback)
 *  - kandidatbegränsning (max 5) och stabilitetskriterierna (kurs/fart)
 *  - clearVessel-städning vid vessel-removal (B6)
 *  - periodisk självstädning (_cleanupExpiredGates + produktionsintervallet)
 *
 * Tidsstyrning: Date.now mockas manuellt och återställs i afterEach.
 * __TEST_MODE__ sätts FÖRE instansiering så cleanup-intervallet inte startas
 * (utom i produktionsläges-sviten som testar just intervallet).
 */

global.__TEST_MODE__ = true;

const GPSJumpGateService = require('../lib/services/GPSJumpGateService');

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const REAL_DATE_NOW = Date.now;
const T0 = 1_700_000_000_000;

// Stabil referensposition (nära Stridsbergsbron) för kandidat-tester
const BASE_VESSEL = {
  lat: 58.29495, lon: 12.296806, cog: 219, sog: 6.7,
};
const PASSAGE = { passed: true };

describe('GPSJumpGateService — gate-livscykel och kandidathantering', () => {
  let now;
  let svc;

  const advance = (ms) => {
    now += ms;
  };

  beforeEach(() => {
    now = T0;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    svc = new GPSJumpGateService(makeLogger(), null);
  });

  afterEach(() => {
    svc.destroy();
    Date.now = REAL_DATE_NOW;
  });

  describe('gate-livscykel: aktivera → blockera → timeout → släpp', () => {
    test('aktiverad gate blockerar passage-detektion och syns i getStatus', () => {
      svc.activateGate('265001', 850, 'gps_jump');

      expect(svc.shouldBlockPassageDetection('265001', { mmsi: 265001 }, 'Klaffbron')).toBe(true);

      const status = svc.getStatus();
      expect(status.gatedVessels).toBe(1);
      expect(status.gates[0]).toMatchObject({
        vesselId: '265001',
        reason: 'gps_jump',
        jumpDistance: 850,
        age: 0,
      });
    });

    test('gate blockerar strax före timeout men släpper och tas bort vid 30 s', () => {
      svc.activateGate('265002', 500);

      advance(29_999);
      expect(svc.shouldBlockPassageDetection('265002', { mmsi: 265002 }, 'Klaffbron')).toBe(true);

      advance(1); // exakt 30 s — age < timeout gäller inte längre
      expect(svc.shouldBlockPassageDetection('265002', { mmsi: 265002 }, 'Klaffbron')).toBe(false);
      // Gaten ska vara BORTTAGEN, inte bara inaktiv
      expect(svc.getStatus().gatedVessels).toBe(0);
    });

    test('clearGate släpper gaten manuellt före timeout', () => {
      svc.activateGate('265003', 400);
      expect(svc.shouldBlockPassageDetection('265003', { mmsi: 265003 }, 'Järnvägsbron')).toBe(true);

      svc.clearGate('265003');
      expect(svc.shouldBlockPassageDetection('265003', { mmsi: 265003 }, 'Järnvägsbron')).toBe(false);
    });

    test('clearGate för okänd vessel är ofarligt (no-op)', () => {
      expect(() => svc.clearGate('finns-inte')).not.toThrow();
    });

    test('ny aktivering ersätter gammal gate (timeout räknas om från senaste hoppet)', () => {
      svc.activateGate('265004', 300);
      advance(25_000);
      svc.activateGate('265004', 600); // nytt hopp — färsk timestamp

      advance(20_000); // 45 s efter första, 20 s efter andra
      expect(svc.shouldBlockPassageDetection('265004', { mmsi: 265004 }, 'Klaffbron')).toBe(true);
      expect(svc.getStatus().gates[0].jumpDistance).toBe(600);
    });

    test('vessel utan gate och utan koordination blockeras inte', () => {
      expect(svc.shouldBlockPassageDetection('265005', { mmsi: 265005 }, 'Klaffbron')).toBe(false);
    });
  });

  describe('GPS-koordination via SystemCoordinator', () => {
    const coordCases = [
      [{ level: 'enhanced', protection: true }, true],
      [{ level: 'system_wide', protection: true }, true],
      [{ level: 'enhanced', protection: false }, false], // protection krävs
      [{ level: 'moderate', protection: true }, false], // bara enhanced/system_wide
      [null, false], // ingen koordination alls
    ];

    test.each(coordCases)(
      'koordination %o → blockering=%s (utan aktiv gate)',
      (coordination, expected) => {
        const coordinator = { getCoordination: jest.fn().mockReturnValue(coordination) };
        const gated = new GPSJumpGateService(makeLogger(), coordinator);

        const blocked = gated.shouldBlockPassageDetection('265010', { mmsi: 265010 }, 'Klaffbron');

        expect(blocked).toBe(expected);
        // Kontraktet: mmsi skickas som STRÄNG till SystemCoordinator
        expect(coordinator.getCoordination).toHaveBeenCalledWith('265010');
        gated.destroy();
      },
    );

    test('utan SystemCoordinator används vessel.lastCoordinationLevel som fallback', () => {
      expect(svc.shouldBlockPassageDetection(
        '265011', { mmsi: 265011, lastCoordinationLevel: 'enhanced' }, 'Klaffbron',
      )).toBe(true);
      expect(svc.shouldBlockPassageDetection(
        '265012', { mmsi: 265012, lastCoordinationLevel: 'system_wide' }, 'Klaffbron',
      )).toBe(true);
      expect(svc.shouldBlockPassageDetection(
        '265013', { mmsi: 265013, lastCoordinationLevel: 'normal' }, 'Klaffbron',
      )).toBe(false);
    });

    test('vessel utan mmsi går till fallback trots att coordinator finns', () => {
      const coordinator = { getCoordination: jest.fn() };
      const gated = new GPSJumpGateService(makeLogger(), coordinator);

      const blocked = gated.shouldBlockPassageDetection(
        'no-mmsi', { lastCoordinationLevel: 'enhanced' }, 'Klaffbron',
      );

      expect(blocked).toBe(true);
      expect(coordinator.getCoordination).not.toHaveBeenCalled();
      gated.destroy();
    });
  });

  describe('kandidatregistrering och stabilitetskriterier', () => {
    test('max 5 kandidater per vessel — äldsta skiftas ut', () => {
      for (let i = 0; i < 6; i++) {
        svc.registerCandidatePassage('265020', `Bro-${i}`, PASSAGE, BASE_VESSEL);
      }

      const candidates = svc._candidatePassages.get('265020');
      expect(candidates).toHaveLength(5);
      expect(candidates.map((c) => c.bridgeName)).toEqual(
        ['Bro-1', 'Bro-2', 'Bro-3', 'Bro-4', 'Bro-5'],
      );
      expect(svc.getStatus().totalCandidates).toBe(5);
    });

    test('kursändring >30° hindrar bekräftelse men kandidaten behålls för retry', () => {
      svc.registerCandidatePassage('265021', 'Stridsbergsbron', PASSAGE, BASE_VESSEL);
      advance(6_000); // > confirmationPeriod (5 s)

      const turned = { ...BASE_VESSEL, cog: 260 }; // 41° kursändring
      expect(svc.confirmStableCandidates('265021', turned)).toHaveLength(0);
      expect(svc._candidatePassages.has('265021')).toBe(true);

      // Kursen stabiliserar sig → bekräftas på nästa tick
      const confirmed = svc.confirmStableCandidates('265021', BASE_VESSEL);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].bridgeName).toBe('Stridsbergsbron');
    });

    test('kurs-wraparound 350°→10° räknas som stabil (20° ändring)', () => {
      svc.registerCandidatePassage('265022', 'Klaffbron', PASSAGE, { ...BASE_VESSEL, cog: 350 });
      advance(6_000);

      const confirmed = svc.confirmStableCandidates('265022', { ...BASE_VESSEL, cog: 10 });
      expect(confirmed).toHaveLength(1);
    });

    test('fartändring >5 kn hindrar bekräftelse', () => {
      svc.registerCandidatePassage('265023', 'Klaffbron', PASSAGE, { ...BASE_VESSEL, sog: 2.0 });
      advance(6_000);

      const speeding = { ...BASE_VESSEL, sog: 7.5 }; // +5.5 kn
      expect(svc.confirmStableCandidates('265023', speeding)).toHaveLength(0);
      expect(svc._candidatePassages.has('265023')).toBe(true);
    });

    test('bekräftelsen är märkt med bro, passageResult och confirmedAt', () => {
      svc.registerCandidatePassage('265024', 'Klaffbron', PASSAGE, BASE_VESSEL);
      advance(6_000);

      const [confirmed] = svc.confirmStableCandidates('265024', BASE_VESSEL);
      expect(confirmed).toEqual({
        bridgeName: 'Klaffbron',
        passageResult: PASSAGE,
        confirmedAt: now,
      });
    });

    test('vessel utan kandidater ger tom lista', () => {
      expect(svc.confirmStableCandidates('265025', BASE_VESSEL)).toEqual([]);
    });
  });

  describe('clearVessel städar ALLT tillstånd vid removal (B6)', () => {
    test('gate + kandidater försvinner så att återkommande mmsi startar rent', () => {
      svc.activateGate('265030', 700);
      svc.registerCandidatePassage('265030', 'Klaffbron', PASSAGE, BASE_VESSEL);
      svc.registerCandidatePassage('265030', 'Järnvägsbron', PASSAGE, BASE_VESSEL);

      svc.clearVessel('265030');

      expect(svc.shouldBlockPassageDetection('265030', { mmsi: 265030 }, 'Klaffbron')).toBe(false);
      advance(6_000);
      // Stale kandidater får INTE kunna bekräftas efter removal
      expect(svc.confirmStableCandidates('265030', BASE_VESSEL)).toEqual([]);
      expect(svc.getStatus()).toMatchObject({ gatedVessels: 0, totalCandidates: 0 });
    });

    test('clearVessel påverkar inte andra vessels tillstånd', () => {
      svc.activateGate('265031', 400);
      svc.activateGate('265032', 400);

      svc.clearVessel('265031');

      expect(svc.shouldBlockPassageDetection('265032', { mmsi: 265032 }, 'Klaffbron')).toBe(true);
    });
  });

  describe('_cleanupExpiredGates: periodisk självstädning', () => {
    test('utgångna gates och kandidater rensas, färska behålls (partiell filtrering)', () => {
      // Gamla poster (blir 31 s gamla)
      svc.activateGate('gammal-gate', 900);
      svc.registerCandidatePassage('gammal-kandidat', 'Klaffbron', PASSAGE, BASE_VESSEL);
      svc.registerCandidatePassage('blandad', 'Klaffbron', PASSAGE, BASE_VESSEL);

      advance(31_000); // > gateTimeout (30 s)

      // Färska poster
      svc.activateGate('färsk-gate', 300);
      svc.registerCandidatePassage('blandad', 'Järnvägsbron', PASSAGE, BASE_VESSEL);
      svc.registerCandidatePassage('färsk-kandidat', 'Stridsbergsbron', PASSAGE, BASE_VESSEL);

      svc._cleanupExpiredGates();

      const status = svc.getStatus();
      expect(status.gatedVessels).toBe(1);
      expect(status.gates[0].vesselId).toBe('färsk-gate');

      // 'gammal-kandidat' helt borta, 'blandad' delvis filtrerad (1 kvar), 'färsk-kandidat' kvar
      expect(svc._candidatePassages.has('gammal-kandidat')).toBe(false);
      expect(svc._candidatePassages.get('blandad')).toHaveLength(1);
      expect(svc._candidatePassages.get('blandad')[0].bridgeName).toBe('Järnvägsbron');
      expect(status.totalCandidates).toBe(2);
    });

    test('kandidater yngre än 30 s överlever städningen (C3: gränsen är gateTimeout, inte 15 s)', () => {
      svc.registerCandidatePassage('265040', 'Klaffbron', PASSAGE, BASE_VESSEL);
      advance(20_000); // äldre än gamla 15s-gränsen men yngre än 30 s

      svc._cleanupExpiredGates();

      // F11-retryn lovar att kandidaten lever tills gateTimeout
      expect(svc._candidatePassages.get('265040')).toHaveLength(1);
    });
  });

  describe('destroy: tömmer tillstånd vid shutdown', () => {
    test('gates och kandidater rensas och blockering upphör', () => {
      svc.activateGate('265050', 500);
      svc.registerCandidatePassage('265050', 'Klaffbron', PASSAGE, BASE_VESSEL);

      svc.destroy();

      expect(svc.getStatus()).toMatchObject({ gatedVessels: 0, totalCandidates: 0 });
      expect(svc.shouldBlockPassageDetection('265050', { mmsi: 265050 }, 'Klaffbron')).toBe(false);
      expect(svc._cleanupTimer).toBeNull();
    });
  });
});

describe('GPSJumpGateService — cleanup-intervallet i produktionsläge', () => {
  const origNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.useFakeTimers(); // fejkar även Date.now konsistent med intervallet
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
  });

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    global.__TEST_MODE__ = true;
    jest.useRealTimers();
  });

  test('intervallet städar utgångna gates automatiskt; destroy stoppar timern', () => {
    const svc = new GPSJumpGateService(makeLogger(), null);
    expect(svc._cleanupTimer).not.toBeNull();

    svc.activateGate('265060', 800);
    jest.advanceTimersByTime(25_000);
    svc.activateGate('265061', 400); // färsk gate 25 s senare

    jest.advanceTimersByTime(15_000); // totalt 40 s — tick vid 40 s städar 265060 (40 s > 30 s)

    expect(svc._gatedVessels.has('265060')).toBe(false);
    expect(svc._gatedVessels.has('265061')).toBe(true); // bara 15 s gammal

    svc.destroy();
    expect(svc._cleanupTimer).toBeNull();
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
  });
});
