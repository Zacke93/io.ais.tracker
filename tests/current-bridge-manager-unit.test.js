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

    test('rensningen sker på FÄRSKT avstånd — ingen fördröjning (fixat 2026-07-03)', () => {
      // Produktionsredo-fixen: avståndet till nuvarande bro räknas om FÖRST,
      // så Regel 2 dömer på färskt värde och rensar direkt vid >600 m.
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 480 });

      manager.updateCurrentBridge(vessel, makeProximity('Klaffbron', 610));
      expect(vessel.currentBridge).toBeNull(); // rensad direkt (610 > 600)
      expect(vessel.distanceToCurrent).toBeNull();
    });

    test('currentBridge fastnar INTE när en ANNAN bro blir närmast (fixat 2026-07-03)', () => {
      // Stuck-fyndet: gamla Regel 3 uppdaterade bara avståndet när nearest
      // VAR currentBridge — annan-bro-närmast frös det lagrade avståndet.
      // Omräkningen läser nu brons färska avstånd ur bridges-listan.
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 400 });
      const proximity = makeProximity('Stallbackabron', 900, {
        bridges: [
          { name: 'Klaffbron', distance: 750 }, // båten har dragit iväg
          { name: 'Stallbackabron', distance: 900 },
        ],
      });

      manager.updateCurrentBridge(vessel, proximity);

      expect(vessel.currentBridge).toBeNull(); // rensad — inte fastnad
      expect(vessel.distanceToCurrent).toBeNull();
    });

    test('utan färskt avstånd för currentBridge behålls lagrat värde (defensivt)', () => {
      // Om proximitetsdatan saknar bron helt (minimal mock) kan avståndet
      // inte räknas om — beteendet degraderar till det gamla (ingen krasch).
      const vessel = makeVessel({ currentBridge: 'Klaffbron', distanceToCurrent: 400 });

      manager.updateCurrentBridge(vessel, makeProximity('Stallbackabron', 900));

      expect(vessel.currentBridge).toBe('Klaffbron');
      expect(vessel.distanceToCurrent).toBe(400);
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

    test('passerad bro i 50–500 m-bandet flappar INTE (fixat 2026-07-03)', () => {
      // Flapp-fyndet: efter Regel 0-rensningen återsatte Regel 1 den
      // passerade bron nästa tick → sätt→rensa-oscillation varannan
      // uppdatering. Regel 1 hoppar nu över nyss passerad bro (>50 m bortom).
      const vessel = makeVessel({
        currentBridge: 'Klaffbron',
        lastPassedBridge: 'Klaffbron',
        distanceToCurrent: 200,
      });
      const proximity = makeProximity('Klaffbron', 200);

      manager.updateCurrentBridge(vessel, proximity);
      expect(vessel.currentBridge).toBeNull(); // rensad (Regel 0)

      manager.updateCurrentBridge(vessel, proximity);
      expect(vessel.currentBridge).toBeNull(); // förblir rensad — ingen flapp

      manager.updateCurrentBridge(vessel, proximity);
      expect(vessel.currentBridge).toBeNull();
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
