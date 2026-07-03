'use strict';

const CurrentBridgeManager = require('../lib/services/CurrentBridgeManager');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

/**
 * Enhetstester för CurrentBridgeManager (kompletterar det triviala testet
 * i tests/currentBridgeManager.test.js — den filen lämnas orörd).
 *
 * Testar hysteresmaskinen för currentBridge:
 *  - Regel 0: passerad bro rensas direkt när båten är > 50 m bort
 *  - Regel 1: sätt currentBridge inom SET_DISTANCE (500 m)
 *  - Regel 2: rensa när lagrat avstånd överskrider CLEAR_DISTANCE (600 m)
 *  - Regel 3: uppdatera avståndet i hysteresbandet 500–600 m
 *  - _validateCurrentBridgeState: reparation av saknat distanceToCurrent
 *    via bridgeDistances (bro-namn → bro-id-uppslag i BridgeRegistry)
 */
describe('CurrentBridgeManager – hysteres för currentBridge', () => {
  let manager;

  const logger = {
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    manager = new CurrentBridgeManager(new BridgeRegistry(), logger);
  });

  afterEach(() => {
    delete global.__TEST_MODE__;
  });

  /** Skapar ett minimalt vessel-objekt */
  function makeVessel(overrides = {}) {
    return {
      mmsi: '265001234',
      currentBridge: null,
      distanceToCurrent: null,
      lastPassedBridge: null,
      ...overrides,
    };
  }

  /** Skapar proximityData med närmaste bro */
  function makeProximity(name, distance, extra = {}) {
    return {
      nearestBridge: name ? { name, distance } : null,
      nearestDistance: distance,
      bridgeDistances: {},
      ...extra,
    };
  }

  // -------------------------------------------------------------------
  // Regel 1: sätt currentBridge inom 500 m
  // -------------------------------------------------------------------

  describe('Regel 1: sätt currentBridge inom SET_DISTANCE (500 m)', () => {
    test('sätter currentBridge och avstånd när närmaste bro är inom 500 m', () => {
      const vessel = makeVessel();

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 450));

      expect(vessel.currentBridge).toBe('Klaffbron');
      expect(vessel.distanceToCurrent).toBe(450);
    });

    test('gränsvärdet 500 m exakt räknas som inom (<=)', () => {
      const vessel = makeVessel();

      manager.updateCurrentBridge(vessel, makeProximity('Järnvägsbron', 500));

      expect(vessel.currentBridge).toBe('Järnvägsbron');
    });

    test('sätter INTE currentBridge vid 501 m när ingen bro är satt', () => {
      const vessel = makeVessel();

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 501));

      expect(vessel.currentBridge).toBeNull();
      expect(vessel.distanceToCurrent).toBeNull();
    });

    test('byter direkt till ny närmaste bro inom 500 m (ingen hysteres mellan broar)', () => {
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 480 });

      manager.updateCurrentBridge(vessel, makeProximity('Järnvägsbron', 300));

      expect(vessel.currentBridge).toBe('Järnvägsbron');
      expect(vessel.distanceToCurrent).toBe(300);
    });
  });

  // -------------------------------------------------------------------
  // Regel 2 + 3: hysteresband och rensning
  // -------------------------------------------------------------------

  describe('Regel 2+3: hysteresband 500–600 m och rensning', () => {
    test('behåller currentBridge i hysteresbandet (500–600 m) och uppdaterar avståndet', () => {
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 480 });

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 550));

      expect(vessel.currentBridge).toBe('Klaffbron'); // ingen flapping vid 550 m
      expect(vessel.distanceToCurrent).toBe(550);
    });

    test('rensar currentBridge när lagrat avstånd överskrider 600 m', () => {
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 650 });

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 700));

      expect(vessel.currentBridge).toBeNull();
      expect(vessel.distanceToCurrent).toBeNull();
    });

    test('rensningen använder LAGRAT avstånd → en uppdaterings fördröjning (dokumenterat beteende)', () => {
      // Regel 2 jämför vessel.distanceToCurrent (föregående värde) mot 600 m,
      // inte det färska avståndet. Första avläsningen bortom 600 m uppdaterar
      // bara avståndet (Regel 3); rensningen sker först nästa avläsning.
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 480 });

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 610));
      expect(vessel.currentBridge).toBe('Klaffbron'); // ännu inte rensad
      expect(vessel.distanceToCurrent).toBe(610);

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 620));
      expect(vessel.currentBridge).toBeNull(); // nu rensad (610 > 600)
    });

    test('KÄND ANOMALI: currentBridge fastnar om en ANNAN bro blir närmast bortom 500 m', () => {
      // Regel 3 uppdaterar bara avståndet när nearest.name === currentBridge.
      // Om närmaste bro plötsligt är en annan (t.ex. efter GPS-hopp) och det
      // lagrade avståndet är <= 600 m rensas currentBridge aldrig — det gamla
      // avståndet fryses. Testet låser nuvarande beteende — rapporterad anomali.
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 400 });

      manager.updateCurrentBridge(vessel, makeProximity('Stallbackabron', 900));

      expect(vessel.currentBridge).toBe('Klaffbron'); // fastnar
      expect(vessel.distanceToCurrent).toBe(400); // fryst gammalt avstånd
    });

    test('ingen närmaste bro alls: currentBridge i bandet behålls oförändrad', () => {
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 550 });

      manager.updateCurrentBridge(vessel, makeProximity(null, null));

      expect(vessel.currentBridge).toBe('Klaffbron');
      expect(vessel.distanceToCurrent).toBe(550);
    });
  });

  // -------------------------------------------------------------------
  // Regel 0: passerad bro
  // -------------------------------------------------------------------

  describe('Regel 0: rensning av passerad bro', () => {
    test('rensar currentBridge direkt när bron är passerad och båten > 50 m bort', () => {
      const vessel = makeVessel({
        currentBridge: 'Klaffbron',
        lastPassedBridge: 'Klaffbron',
        distanceToCurrent: 120,
      });

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 120));

      expect(vessel.currentBridge).toBeNull();
      expect(vessel.distanceToCurrent).toBeNull();
    });

    test('rensar INTE passerad bro inom 50 m (båten fortfarande under bron)', () => {
      const vessel = makeVessel({
        currentBridge: 'Klaffbron',
        lastPassedBridge: 'Klaffbron',
        distanceToCurrent: 40,
      });

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 40));

      expect(vessel.currentBridge).toBe('Klaffbron');
    });

    test('rensar inte när passerad bro är en ANNAN än currentBridge', () => {
      const vessel = makeVessel({
        currentBridge: 'Järnvägsbron',
        lastPassedBridge: 'Klaffbron',
        distanceToCurrent: 200,
      });

      manager.updateCurrentBridge(vessel, makeProximity('Järnvägsbron', 200));

      expect(vessel.currentBridge).toBe('Järnvägsbron');
      expect(vessel.distanceToCurrent).toBe(200);
    });

    test('KÄND ANOMALI: passerad bro i 50–500 m-bandet flappar sätt→rensa varannan uppdatering', () => {
      // Efter rensningen (Regel 0) är currentBridge null → nästa uppdatering
      // sätter Regel 1 tillbaka den passerade bron (inom 500 m) → uppdateringen
      // därefter rensar Regel 0 igen. Testet låser nuvarande beteende.
      const vessel = makeVessel({
        currentBridge: 'Klaffbron',
        lastPassedBridge: 'Klaffbron',
        distanceToCurrent: 200,
      });
      const proximity = makeProximity('Klaffbron', 200);

      manager.updateCurrentBridge(vessel, proximity);
      expect(vessel.currentBridge).toBeNull(); // rensad (Regel 0)

      manager.updateCurrentBridge(vessel, proximity);
      expect(vessel.currentBridge).toBe('Klaffbron'); // återsatt (Regel 1)

      manager.updateCurrentBridge(vessel, proximity);
      expect(vessel.currentBridge).toBeNull(); // rensad igen (Regel 0)
    });
  });

  // -------------------------------------------------------------------
  // _validateCurrentBridgeState: reparation av distanceToCurrent
  // -------------------------------------------------------------------

  describe('validering: reparation av saknat distanceToCurrent', () => {
    test('reparerar null-avstånd från bridgeDistances via bro-id-uppslag', () => {
      // Klaffbron (namn) → klaffbron (id) i bridgeDistances
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: null });
      const proximity = makeProximity('Stallbackabron', 800, {
        bridgeDistances: { klaffbron: 320 },
      });

      manager.updateCurrentBridge(vessel, proximity);

      expect(vessel.currentBridge).toBe('Klaffbron');
      expect(vessel.distanceToCurrent).toBe(320);
    });

    test('avstånd 0 (rakt under bron) behandlas som ogiltigt och skrivs över (dokumenterat beteende)', () => {
      // Valideringen testar `!distanceToCurrent || distanceToCurrent === 0` —
      // ett legitimt 0-avstånd ersätts därför med värdet ur bridgeDistances.
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 0 });
      const proximity = makeProximity('Stallbackabron', 800, {
        bridgeDistances: { klaffbron: 15 },
      });

      manager.updateCurrentBridge(vessel, proximity);

      expect(vessel.distanceToCurrent).toBe(15);
    });

    test('okänt bronamn i currentBridge kraschar inte (bro-id hittas ej)', () => {
      const vessel = makeVessel({ currentBridge: 'Fantasibron', distanceToCurrent: null });
      const proximity = makeProximity('Stallbackabron', 800, {
        bridgeDistances: { klaffbron: 320 },
      });

      expect(() => manager.updateCurrentBridge(vessel, proximity)).not.toThrow();
      expect(vessel.currentBridge).toBe('Fantasibron');
      expect(vessel.distanceToCurrent).toBeNull();
    });

    test('saknade bridgeDistances lämnar avståndet orört utan att kasta', () => {
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: null });
      const proximity = makeProximity('Stallbackabron', 800, { bridgeDistances: undefined });

      expect(() => manager.updateCurrentBridge(vessel, proximity)).not.toThrow();
      expect(vessel.distanceToCurrent).toBeNull();
    });
  });
});
