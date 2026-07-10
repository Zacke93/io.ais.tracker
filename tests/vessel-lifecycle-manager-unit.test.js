'use strict';

const VesselLifecycleManager = require('../lib/services/VesselLifecycleManager');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

/**
 * Enhetstester för VesselLifecycleManager.
 *
 * Testar terminal-bro-designen för resefullbordan:
 *  - norrut: Stallbackabron passerad OCH lat > 58.3141 (300 m norr om bron)
 *  - söderut: Olidebron passerad OCH lat < 58.2653 (300 m söder om Kanalinfarten)
 *  - _finalTargetDirection (låst riktning) prioriteras över drivande COG
 *  - shouldEliminateVessel kräver targetBridge === null (strikt)
 *  - U-svängs-regressionen (Anomali 2, AMELIA 2026-05-05)
 *  - getJourneyStatus/getEliminationStats-rapportering
 */
describe('VesselLifecycleManager – resefullbordan och eliminering', () => {
  let manager;

  const logger = {
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  // Exit-latituder från modulen (låsta konstanter)
  const NORR_OM_STALLBACKA = 58.3200; // > 58.3141
  const SODER_OM_KANALINFARTEN = 58.2600; // < 58.2653

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    manager = new VesselLifecycleManager(logger, new BridgeRegistry());
  });

  afterEach(() => {
    delete global.__TEST_MODE__;
  });

  /** Skapar ett minimalt vessel-objekt */
  function makeVessel(overrides = {}) {
    return {
      mmsi: '265001234',
      targetBridge: null,
      lastPassedBridge: null,
      cog: 0,
      lat: 58.29,
      lon: 12.28,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------
  // shouldEliminateVessel: grundvillkor
  // -------------------------------------------------------------------

  describe('shouldEliminateVessel – grundvillkor', () => {
    test('null-input elimineras inte (kraschar inte)', () => {
      expect(manager.shouldEliminateVessel(null)).toBe(false);
      expect(manager.shouldEliminateVessel(undefined)).toBe(false);
      expect(manager.shouldEliminateVessel('inte-ett-objekt')).toBe(false);
    });

    test('båt med aktiv målbro elimineras aldrig', () => {
      const vessel = makeVessel({
        targetBridge: 'Klaffbron',
        lastPassedBridge: 'Stallbackabron',
        lat: NORR_OM_STALLBACKA,
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });

    test('targetBridge undefined räknas INTE som null (strikt kontroll)', () => {
      const vessel = makeVessel({
        lastPassedBridge: 'Stallbackabron',
        lat: NORR_OM_STALLBACKA,
      });
      delete vessel.targetBridge; // undefined, inte null

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });

    test('ingen registrerad passage → ingen eliminering', () => {
      const vessel = makeVessel({ targetBridge: null, lastPassedBridge: null });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
      expect(manager.hasCompletedJourney(vessel)).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Norrut: Stallbackabron + exit-latitud
  // -------------------------------------------------------------------

  describe('norrut-fullbordan (Stallbackabron + lat > 58.3141)', () => {
    test('norrgående båt norr om Stallbackabron-exitzonen elimineras', () => {
      const vessel = makeVessel({
        cog: 10,
        lastPassedBridge: 'Stallbackabron',
        lat: NORR_OM_STALLBACKA,
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(true);
    });

    test('norrgående båt som passerat Stallbackabron men INTE nått exitzonen behålls', () => {
      const vessel = makeVessel({
        cog: 10,
        lastPassedBridge: 'Stallbackabron',
        lat: 58.3120, // strax norr om bron men söder om 58.3141
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });

    test('norrgående båt vars sista passage är en annan bro behålls', () => {
      const vessel = makeVessel({
        cog: 10,
        lastPassedBridge: 'Stridsbergsbron',
        lat: NORR_OM_STALLBACKA,
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });

    test('ogiltigt lat (NaN/undefined) blockerar eliminering', () => {
      const vessel = makeVessel({
        cog: 10,
        lastPassedBridge: 'Stallbackabron',
        lat: Number.NaN,
      });
      expect(manager.shouldEliminateVessel(vessel)).toBe(false);

      vessel.lat = undefined;
      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });

    test('U-svängs-regression (Anomali 2/AMELIA): norrgående med gammal Stallbacka-passage MITT i kanalen elimineras inte', () => {
      // lastPassedBridge='Stallbackabron' från en TIDIGARE södergående passage
      // får inte tolkas som norrut-fullbordan när båten är kvar i kanalen.
      const vessel = makeVessel({
        cog: 0,
        lastPassedBridge: 'Stallbackabron',
        lat: 58.2950, // mitt i kanalen, långt söder om exitzonen
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Söderut: Olidebron + Kanalinfarten-exitzon
  // -------------------------------------------------------------------

  describe('söderut-fullbordan (Olidebron + lat < 58.2653)', () => {
    test('södergående båt söder om Kanalinfarten-exitzonen elimineras', () => {
      const vessel = makeVessel({
        cog: 180,
        lastPassedBridge: 'Olidebron',
        lat: SODER_OM_KANALINFARTEN,
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(true);
    });

    test('södergående båt som passerat Olidebron men är kvar i Kanalinfarten-zonen behålls', () => {
      // Utan lat-checken skulle båten elimineras direkt efter Olidebron och
      // Kanalinfarten-notisen ~700 m längre söderut aldrig triggas.
      const vessel = makeVessel({
        cog: 180,
        lastPassedBridge: 'Olidebron',
        lat: 58.2700, // norr om exitgränsen 58.2653
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });

    test('södergående båt vars sista passage är Klaffbron behålls', () => {
      const vessel = makeVessel({
        cog: 180,
        lastPassedBridge: 'Klaffbron',
        lat: SODER_OM_KANALINFARTEN,
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });

    test('ogiltigt lat blockerar söderut-eliminering', () => {
      const vessel = makeVessel({
        cog: 180,
        lastPassedBridge: 'Olidebron',
        lat: undefined,
      });

      expect(manager.shouldEliminateVessel(vessel)).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Riktningsbestämning: låst riktning vs COG
  // -------------------------------------------------------------------

  describe('riktningsbestämning', () => {
    test('_finalTargetDirection="north" prioriteras över drivande söderut-COG', () => {
      // Båten har stannat/manövrerat efter terminal-passagen → COG pekar söderut,
      // men den låsta riktningen ska styra fullbordansbedömningen.
      const vessel = makeVessel({
        cog: 180,
        _finalTargetDirection: 'north',
        lastPassedBridge: 'Stallbackabron',
        lat: NORR_OM_STALLBACKA,
      });

      expect(manager.hasCompletedJourney(vessel)).toBe(true);
    });

    test('_finalTargetDirection="south" prioriteras över drivande norrut-COG', () => {
      const vessel = makeVessel({
        cog: 10,
        _finalTargetDirection: 'south',
        lastPassedBridge: 'Olidebron',
        lat: SODER_OM_KANALINFARTEN,
      });

      expect(manager.hasCompletedJourney(vessel)).toBe(true);
    });

    test('COG-gränser: 315° och 45° räknas som norrut, 46° och 314° som söderut', () => {
      const northVessel = makeVessel({ lastPassedBridge: 'Stallbackabron', lat: NORR_OM_STALLBACKA });

      northVessel.cog = 315;
      expect(manager.hasCompletedJourney(northVessel)).toBe(true);
      northVessel.cog = 45;
      expect(manager.hasCompletedJourney(northVessel)).toBe(true);

      // 46°/314° → söderut-regler → Stallbackabron kvalificerar inte
      northVessel.cog = 46;
      expect(manager.hasCompletedJourney(northVessel)).toBe(false);
      northVessel.cog = 314;
      expect(manager.hasCompletedJourney(northVessel)).toBe(false);
    });

    test('saknad COG (undefined) faller tillbaka på söderut-regler', () => {
      // _isNorthbound(undefined) → false → söderut. Dokumenterat beteende.
      const vessel = makeVessel({
        cog: undefined,
        lastPassedBridge: 'Olidebron',
        lat: SODER_OM_KANALINFARTEN,
      });

      expect(manager.hasCompletedJourney(vessel)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // getJourneyStatus: rapportering
  // -------------------------------------------------------------------

  describe('getJourneyStatus – rapportering', () => {
    test('aktiv resa rapporteras med målbro i reason', () => {
      const status = manager.getJourneyStatus(makeVessel({ targetBridge: 'Klaffbron' }));

      expect(status.hasTarget).toBe(true);
      expect(status.shouldEliminate).toBe(false);
      expect(status.reason).toBe('Active journey - target: Klaffbron');
    });

    test('fullbordad norrut-resa rapporteras som completed', () => {
      const status = manager.getJourneyStatus(makeVessel({
        cog: 10,
        lastPassedBridge: 'Stallbackabron',
        lat: NORR_OM_STALLBACKA,
      }));

      expect(status.hasPassage).toBe(true);
      expect(status.isNorthbound).toBe(true);
      expect(status.isLastTarget).toBe(true);
      expect(status.shouldEliminate).toBe(true);
      expect(status.reason).toBe('Journey completed - passed final target bridge Stallbackabron (northbound)');
    });

    test('utan mål och utan passage rapporteras som obedömbar', () => {
      const status = manager.getJourneyStatus(makeVessel());

      expect(status.hasPassage).toBe(false);
      expect(status.shouldEliminate).toBe(false);
      expect(status.reason).toBe('No target, no passage recorded - cannot determine completion');
    });

    test('utan mål men ej fullbordad rapporteras med senaste passage', () => {
      const status = manager.getJourneyStatus(makeVessel({
        cog: 180,
        lastPassedBridge: 'Järnvägsbron',
      }));

      expect(status.isLastTarget).toBe(false);
      expect(status.reason).toBe('No target but not completed - last passage: Järnvägsbron');
    });

    test('SYS-6 FIXAD: reason-riktningen följer låst _finalTargetDirection, inte drift-COG', () => {
      // Fable-granskningen 2026-07-10b (SYS-6): den tidigare "KÄNDA ANOMALIN"
      // (etiketten läste rå cog → "southbound" för en norrut-fullbordan) är
      // åtgärdad — etiketten använder nu samma källa som beslutet
      // (_finalTargetDirection || _routeDirection, cog endast som fallback).
      const status = manager.getJourneyStatus(makeVessel({
        cog: 180,
        _finalTargetDirection: 'north',
        lastPassedBridge: 'Stallbackabron',
        lat: NORR_OM_STALLBACKA,
      }));

      expect(status.isNorthbound).toBe(true);
      expect(status.shouldEliminate).toBe(true);
      expect(status.reason).toBe('Journey completed - passed final target bridge Stallbackabron (northbound)');
    });

    test('logJourneyAnalysis loggar via logger.debug utan att kasta', () => {
      expect(() => manager.logJourneyAnalysis(makeVessel({ targetBridge: 'Klaffbron' }))).not.toThrow();
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // getEliminationStats: aggregering
  // -------------------------------------------------------------------

  describe('getEliminationStats – aggregering', () => {
    test('kategoriserar aktiva resor, elimineringskandidater och okända', () => {
      const vessels = new Map([
        ['1', makeVessel({ targetBridge: 'Klaffbron' })], // aktiv
        ['2', makeVessel({ cog: 180, lastPassedBridge: 'Olidebron', lat: SODER_OM_KANALINFARTEN })], // kandidat
        ['3', makeVessel()], // okänd (ingen passage)
        ['4', makeVessel({ cog: 180, lastPassedBridge: 'Klaffbron' })], // okänd (ej fullbordad)
      ]);

      const stats = manager.getEliminationStats(vessels);

      expect(stats.totalVessels).toBe(4);
      expect(stats.activeJourneys).toBe(1);
      expect(stats.eliminationCandidates).toBe(1);
      expect(stats.unknownStatus).toBe(2);
      expect(stats.potentialSavings).toBe('25%');
    });

    test('tom vessel-map ger 0% besparing utan division-med-noll', () => {
      const stats = manager.getEliminationStats(new Map());

      expect(stats.totalVessels).toBe(0);
      expect(stats.potentialSavings).toBe('0%');
    });
  });
});
