'use strict';

const RouteOrderValidator = require('../lib/services/RouteOrderValidator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

/**
 * Enhetstester för RouteOrderValidator.
 *
 * Testar sekvensvalideringen som blockerar fysiskt omöjliga bropassager:
 *  - riktningsbestämning från COG (inkl. normalisering av negativa värden)
 *  - next-in-sequence, tillåtna hopp (max 2 broar), bakåtblockering
 *  - specialfall: dubblettpassage, vändning (riktningsbyte), lång tid (>30 min)
 *  - historikhantering: 10-postersgräns, clearVesselHistory, 2h-cleanup, destroy
 *
 * Sekvensindex (söderut): Stallbackabron(0) → Stridsbergsbron(1) →
 * Järnvägsbron(2) → Klaffbron(3) → Olidebron(4). Norrut är omvänd ordning.
 */
describe('RouteOrderValidator – validering av broordning', () => {
  let validator;
  let mockNow;
  const realDateNow = Date.now;

  const logger = {
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const MMSI = '265001234';

  /** Skapar ett minimalt vessel-objekt med given COG */
  function makeVessel(cog, overrides = {}) {
    return {
      mmsi: MMSI,
      cog,
      lat: 58.28,
      lon: 12.28,
      sog: 5.0, // fältet heter sog (S-F1) — registerPassage lagrar vessel.sog
      ...overrides,
    };
  }

  beforeEach(() => {
    global.__TEST_MODE__ = true; // FÖRE instansiering — annars startas cleanup-intervallet
    mockNow = new Date(2026, 6, 1, 12, 0, 0).getTime();
    Date.now = () => mockNow;
    validator = new RouteOrderValidator(logger, new BridgeRegistry());
  });

  afterEach(() => {
    validator.destroy();
    Date.now = realDateNow;
    delete global.__TEST_MODE__;
  });

  // -------------------------------------------------------------------
  // Grundfall: första passage och okänd riktning
  // -------------------------------------------------------------------

  describe('första passage och okänd riktning', () => {
    test('första passagen tillåts alltid (tom historik)', () => {
      const result = validator.validatePassageOrder(MMSI, 'Klaffbron', makeVessel(180));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('first_passage_or_unknown_direction');
      expect(result.confidence).toBe(1.0);
    });

    test('östlig COG (90°) ger okänd riktning → passagen tillåts trots historik', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));

      const result = validator.validatePassageOrder(MMSI, 'Stallbackabron', makeVessel(90));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('first_passage_or_unknown_direction');
    });

    test('saknad COG (undefined) ger okänd riktning → passagen tillåts', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));

      const result = validator.validatePassageOrder(MMSI, 'Stallbackabron', makeVessel(undefined));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('first_passage_or_unknown_direction');
    });
  });

  // -------------------------------------------------------------------
  // Sekvensvalidering
  // -------------------------------------------------------------------

  describe('sekvensordning', () => {
    test('nästa bro i söderut-sekvensen är giltig (Stridsbergsbron → Järnvägsbron)', () => {
      validator.registerPassage(MMSI, 'Stridsbergsbron', makeVessel(180));

      const result = validator.validatePassageOrder(MMSI, 'Järnvägsbron', makeVessel(180));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('next_in_sequence');
      expect(result.confidence).toBe(1.0);
    });

    test('negativ COG normaliseras: -10° tolkas som norrut (Klaffbron → Järnvägsbron)', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(350));

      const result = validator.validatePassageOrder(MMSI, 'Järnvägsbron', makeVessel(-10));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('next_in_sequence');
    });

    test('hopp över max 2 broar tillåts (Stallbackabron → Klaffbron söderut)', () => {
      validator.registerPassage(MMSI, 'Stallbackabron', makeVessel(180));

      const result = validator.validatePassageOrder(MMSI, 'Klaffbron', makeVessel(180));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('valid_sequence_skip');
      expect(result.confidence).toBe(0.8);
    });

    test('hopp över 3 broar blockeras (Stallbackabron → Olidebron söderut)', () => {
      validator.registerPassage(MMSI, 'Stallbackabron', makeVessel(180));

      const result = validator.validatePassageOrder(MMSI, 'Olidebron', makeVessel(180));

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('sequence_too_far_forward');
    });

    test('bakåtpassage blockeras (Järnvägsbron → Stridsbergsbron söderut)', () => {
      validator.registerPassage(MMSI, 'Järnvägsbron', makeVessel(180));

      const result = validator.validatePassageOrder(MMSI, 'Stridsbergsbron', makeVessel(180));

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('backwards_sequence_Järnvägsbron_to_Stridsbergsbron');
      expect(result.confidence).toBe(0.9);
    });

    test('bro utanför sekvensen tillåts (t.ex. Kanalinfarten)', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));

      const result = validator.validatePassageOrder(MMSI, 'Kanalinfarten', makeVessel(180));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('bridge_not_in_sequence');
      expect(result.confidence).toBe(0.7);
    });
  });

  // -------------------------------------------------------------------
  // Tidsfönster och specialfall
  // -------------------------------------------------------------------

  describe('tidsfönster och specialfall', () => {
    test('dubblettpassage av samma bro inom 60 s blockeras', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));
      mockNow += 30 * 1000; // 30 s senare

      const result = validator.validatePassageOrder(MMSI, 'Klaffbron', makeVessel(180));

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('duplicate_passage_too_soon');
    });

    test('sambro-passage mellan 1 och 30 min (samma riktning) blockeras — reason blir "sequence_too_far_forward" (dokumenterat nuvarande beteende)', () => {
      // OBS: reason är missvisande för sambro-fallet (index är lika, inte "för långt fram"),
      // men beteendet (blockering) är avsiktligt. Testet låser nuvarande kontrakt.
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));
      mockNow += 5 * 60 * 1000; // 5 min senare

      const result = validator.validatePassageOrder(MMSI, 'Klaffbron', makeVessel(180));

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('sequence_too_far_forward');
    });

    test('bakåtpassage tillåts efter mer än 30 min (möjlig återvändo)', () => {
      validator.registerPassage(MMSI, 'Järnvägsbron', makeVessel(180));
      mockNow += 31 * 60 * 1000; // 31 min senare

      const result = validator.validatePassageOrder(MMSI, 'Stridsbergsbron', makeVessel(180));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('long_time_elapsed_possible_return');
      expect(result.confidence).toBe(0.6);
    });

    test('riktningsbyte (vändning) tillåter annars ogiltig passage', () => {
      // Söderut förbi Stridsbergsbron, sedan vändning norrut mot Klaffbron:
      // i norrut-sekvensen är Klaffbron(1) bakåt från Stridsbergsbron(3),
      // men riktningsbytet syd→nord gör passagen legitim.
      validator.registerPassage(MMSI, 'Stridsbergsbron', makeVessel(180));
      mockNow += 5 * 60 * 1000;

      const result = validator.validatePassageOrder(MMSI, 'Klaffbron', makeVessel(10));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('direction_change_detected');
      expect(result.confidence).toBe(0.7);
    });

    test('FIXAT 2026-07-05: COG exakt 0° detekteras som riktningsbyte (Number.isFinite-check)', () => {
      // Tidigare gjorde _hasDirectionChanged `!currentVessel.cog`, vilket är
      // sant för 0 (rakt norrut) — vändningen missades och passagen blockerades
      // som bakåtpassage. Nu släpper Number.isFinite igenom 0 och vändningen
      // syd→nord gör passagen legitim.
      validator.registerPassage(MMSI, 'Stridsbergsbron', makeVessel(180));
      mockNow += 5 * 60 * 1000;

      const result = validator.validatePassageOrder(MMSI, 'Klaffbron', makeVessel(0));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('direction_change_detected');
      expect(result.confidence).toBe(0.7);
    });
  });

  // -------------------------------------------------------------------
  // Historikhantering
  // -------------------------------------------------------------------

  describe('historikhantering', () => {
    test('historiken begränsas till 10 passager per båt', () => {
      for (let i = 0; i < 12; i++) {
        validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));
        mockNow += 60 * 1000;
      }

      const status = validator.getStatus();
      expect(status.vesselCount).toBe(1);
      expect(status.vessels[0].passageCount).toBe(10);
    });

    test('clearVesselHistory nollställer så nästa validering blir "första passage"', () => {
      validator.registerPassage(MMSI, 'Järnvägsbron', makeVessel(180));
      validator.clearVesselHistory(MMSI, 'gps_jump');

      const result = validator.validatePassageOrder(MMSI, 'Stridsbergsbron', makeVessel(180));

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('first_passage_or_unknown_direction');
    });

    test('clearVesselHistory för okänd båt kastar inte', () => {
      expect(() => validator.clearVesselHistory('999999999', 'test')).not.toThrow();
    });

    test('_cleanupOldHistory tar bort passager äldre än 2 timmar', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180)); // gammal
      mockNow += (2 * 60 * 60 * 1000) + 60 * 1000; // 2h 1min senare
      validator.registerPassage('265009999', 'Olidebron', makeVessel(180)); // färsk

      validator._cleanupOldHistory();

      const status = validator.getStatus();
      expect(status.vesselCount).toBe(1);
      expect(status.vessels[0].vesselId).toBe('265009999');
    });

    test('_cleanupOldHistory behåller färska passager för samma båt', () => {
      validator.registerPassage(MMSI, 'Stallbackabron', makeVessel(180)); // blir gammal
      mockNow += (2 * 60 * 60 * 1000) + 60 * 1000;
      validator.registerPassage(MMSI, 'Stridsbergsbron', makeVessel(180)); // färsk

      validator._cleanupOldHistory();

      const status = validator.getStatus();
      expect(status.vesselCount).toBe(1);
      expect(status.totalPassages).toBe(1);
      expect(status.vessels[0].lastPassage.bridgeName).toBe('Stridsbergsbron');
    });

    test('getStatus rapporterar korrekt för tom historik', () => {
      const status = validator.getStatus();

      expect(status.vesselCount).toBe(0);
      expect(status.totalPassages).toBe(0);
      expect(status.vessels).toEqual([]);
    });

    test('getStatus rapporterar senaste passage med ålder', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));
      mockNow += 90 * 1000;

      const status = validator.getStatus();

      expect(status.vessels[0].lastPassage.bridgeName).toBe('Klaffbron');
      expect(status.vessels[0].lastPassage.age).toBe(90 * 1000);
    });

    test('destroy tömmer all historik', () => {
      validator.registerPassage(MMSI, 'Klaffbron', makeVessel(180));
      validator.destroy();

      expect(validator.getStatus().vesselCount).toBe(0);
    });
  });
});
