'use strict';

const PassageLatchService = require('../lib/services/PassageLatchService');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

/**
 * Beteendetester för PassageLatchService — latch-livscykeln.
 *
 * Verkligt kontrakt (från anroparna):
 * - VesselDataService registrerar passage via registerPassage(mmsi, bridgeName,
 *   direction) där direction kommer från _safeDetermineDirection(cog) och kan
 *   vara null vid osäker COG.
 * - StatusService frågar shouldBlockStatus(mmsi, bridge, status, cog) för
 *   'waiting', 'approaching' och 'stallbacka-waiting'.
 * - app.js anropar handleGPSJump(mmsi, distance, vessel) vid GPS-hopp.
 * - VesselDataService anropar clearVesselLatches(mmsi, reason) när ett fartyg
 *   tas bort — per-fartygs-tillstånd MÅSTE försvinna (långtidsdrift).
 */
describe('PassageLatchService — latch-livscykeln', () => {
  let svc;
  let mockNow;
  const realDateNow = Date.now;

  const MMSI = '265001234';
  const OTHER_MMSI = '265009999';
  const TEN_MIN = 10 * 60 * 1000;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 6, 3, 12, 0, 0).getTime();
    Date.now = () => mockNow;
    svc = new PassageLatchService(makeLogger());
  });

  afterEach(() => {
    if (svc) {
      svc.destroy();
      svc = null;
    }
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  describe('registrering och blockering', () => {
    test('registrerad passage blockerar alla retrograda statusar men inte "under-bridge"', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');

      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(true);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'approaching')).toBe(true);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'stallbacka-waiting')).toBe(true);
      // Icke-retrograda statusar släpps alltid igenom
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'under-bridge')).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'passed')).toBe(false);
    });

    test('okänd bro (ej i kanalen) registreras aldrig', () => {
      svc.registerPassage(MMSI, 'Fritidsbron', 'north');
      expect(svc.shouldBlockStatus(MMSI, 'Fritidsbron', 'waiting')).toBe(false);
      expect(svc.getStatus().totalLatches).toBe(0);
    });

    test('ofullständiga argument registreras aldrig och blockerar aldrig', () => {
      svc.registerPassage(null, 'Klaffbron', 'north');
      svc.registerPassage(MMSI, null, 'north');
      expect(svc.getStatus().totalLatches).toBe(0);

      expect(svc.shouldBlockStatus(null, 'Klaffbron', 'waiting')).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, null, 'waiting')).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', null)).toBe(false);
    });

    test('latch är per båt+bro: annan båt och annan bro påverkas inte', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');

      expect(svc.shouldBlockStatus(OTHER_MMSI, 'Klaffbron', 'waiting')).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Stridsbergsbron', 'waiting')).toBe(false);
    });

    test('passage med osäker riktning (direction=null) blockerar konservativt även vid motsatt COG', () => {
      // VesselDataService._safeDetermineDirection returnerar null vid osäker
      // COG — latchen ska då INTE släppa på riktningsvändning (F13-kontraktet:
      // släpp bara när BÅDA riktningarna är entydiga och olika).
      svc.registerPassage(MMSI, 'Klaffbron', null);

      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting', 180)).toBe(true);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting', 10)).toBe(true);
    });
  });

  describe('tidsfönster: 10-minuters timeout', () => {
    test('latch blockerar fortfarande vid exakt 10 minuter (gränsen är strikt >)', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      mockNow += TEN_MIN;
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(true);
    });

    test('utgången latch slutar blockera och tas bort lazily vid nästa fråga', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      mockNow += TEN_MIN + 1000;

      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(false);
      // Latchen ska ha raderats — inte bara ignorerats
      expect(svc.getStatus().totalLatches).toBe(0);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(false);
    });

    test('omregistrering förnyar tidsstämpeln — latchen lever vidare från senaste passagen', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      mockNow += 8 * 60 * 1000;
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      mockNow += 8 * 60 * 1000; // 16 min efter första, 8 min efter andra

      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(true);
    });
  });

  describe('shouldBlockMessage — meddelandenivån', () => {
    test('blockerar Stallbacka-specifika meddelanden efter passage av Stallbackabron', () => {
      svc.registerPassage(MMSI, 'Stallbackabron', 'north');

      expect(svc.shouldBlockMessage(MMSI, 'Stallbackabron', 'stallbacka-waiting')).toBe(true);
      expect(svc.shouldBlockMessage(MMSI, 'Stallbackabron', 'approaching')).toBe(true);
    });

    test('blockerar standardmeddelanden för övriga broar efter passage', () => {
      svc.registerPassage(MMSI, 'Järnvägsbron', 'south');

      expect(svc.shouldBlockMessage(MMSI, 'Järnvägsbron', 'waiting')).toBe(true);
      expect(svc.shouldBlockMessage(MMSI, 'Järnvägsbron', 'under-bridge')).toBe(false);
    });

    test('utan registrerad passage blockeras inga meddelanden', () => {
      expect(svc.shouldBlockMessage(MMSI, 'Stallbackabron', 'stallbacka-waiting')).toBe(false);
      expect(svc.shouldBlockMessage(MMSI, 'Klaffbron', 'waiting')).toBe(false);
    });
  });

  describe('clearLatch / clearVesselLatches — riktad rensning', () => {
    test('clearLatch rensar bara den angivna bron, andra latches kvarstår', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      svc.registerPassage(MMSI, 'Järnvägsbron', 'north');

      svc.clearLatch(MMSI, 'Klaffbron');

      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Järnvägsbron', 'waiting')).toBe(true);
    });

    test('clearLatch på okänd båt/bro är en no-op utan krasch', () => {
      expect(() => svc.clearLatch(MMSI, 'Klaffbron')).not.toThrow();
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      expect(() => svc.clearLatch(MMSI, 'Olidebron')).not.toThrow();
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(true);
    });

    test('clearVesselLatches tar bort ALLT per-fartygs-tillstånd (vessel_removed-vägen)', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      svc.registerPassage(MMSI, 'Stridsbergsbron', 'north');
      svc.registerPassage(OTHER_MMSI, 'Olidebron', 'south');

      svc.clearVesselLatches(MMSI, 'vessel_removed');

      // Viktigt för långtidsdrift: hela vessel-entryn ska vara borta ur mappen
      expect(svc._passageLatches.has(MMSI)).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Stridsbergsbron', 'waiting')).toBe(false);
      // Andra fartyg påverkas inte
      expect(svc.shouldBlockStatus(OTHER_MMSI, 'Olidebron', 'waiting')).toBe(true);
      expect(svc.getStatus()).toMatchObject({ vesselCount: 1, totalLatches: 1 });
    });

    test('clearVesselLatches på okänt fartyg är en no-op utan krasch', () => {
      expect(() => svc.clearVesselLatches(MMSI)).not.toThrow();
    });
  });

  describe('handleGPSJump — hopphantering', () => {
    beforeEach(() => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      svc.registerPassage(MMSI, 'Järnvägsbron', 'north');
    });

    test('stort hopp (>1000 m) rensar alla latches för fartyget', () => {
      svc.handleGPSJump(MMSI, 1001, {});

      expect(svc._passageLatches.has(MMSI)).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(false);
      expect(svc.shouldBlockStatus(MMSI, 'Järnvägsbron', 'waiting')).toBe(false);
    });

    test('hopp på exakt 1000 m behåller latches (gränsen är strikt >)', () => {
      svc.handleGPSJump(MMSI, 1000, {});
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(true);
    });

    test('litet hopp behåller latches för stabilitet', () => {
      svc.handleGPSJump(MMSI, 150, {});
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(true);
      expect(svc.shouldBlockStatus(MMSI, 'Järnvägsbron', 'waiting')).toBe(true);
    });
  });

  describe('periodisk cleanup av utgångna latches', () => {
    test('rensar bara utgångna latches och tar bort tomma vessel-entries', () => {
      // t0: en latch per fartyg
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      svc.registerPassage(OTHER_MMSI, 'Olidebron', 'south');
      // t0+9min: färsk latch på andra bron för första fartyget
      mockNow += 9 * 60 * 1000;
      svc.registerPassage(MMSI, 'Stridsbergsbron', 'north');
      // t0+11min: Klaffbron & Olidebron utgångna, Stridsbergsbron 2 min gammal
      mockNow += 2 * 60 * 1000;

      svc._cleanupExpiredLatches();

      // Utgångna borta, färsk kvar
      expect(svc.shouldBlockStatus(MMSI, 'Stridsbergsbron', 'waiting')).toBe(true);
      expect(svc.getStatus()).toMatchObject({ vesselCount: 1, totalLatches: 1 });
      // Fartyg vars alla latches gått ut ska försvinna HELT ur mappen
      expect(svc._passageLatches.has(OTHER_MMSI)).toBe(false);
    });

    test('produktionsläge: cleanup-timern startar, rensar via intervallet och stoppas av destroy', () => {
      const oldEnv = process.env.NODE_ENV;
      const oldTestMode = global.__TEST_MODE__;
      process.env.NODE_ENV = 'production';
      delete global.__TEST_MODE__;
      jest.useFakeTimers({ doNotFake: ['Date'] });

      let prodSvc;
      try {
        prodSvc = new PassageLatchService(makeLogger());
        expect(prodSvc._cleanupTimer).not.toBeNull();

        prodSvc.registerPassage(MMSI, 'Klaffbron', 'north');
        mockNow += TEN_MIN + 1000; // latchen har gått ut
        jest.advanceTimersByTime(60 * 1000); // ett intervall-tick

        expect(prodSvc.getStatus().totalLatches).toBe(0);
        expect(prodSvc._passageLatches.has(MMSI)).toBe(false);

        prodSvc.destroy();
        expect(prodSvc._cleanupTimer).toBeNull();
        prodSvc = null;
      } finally {
        if (prodSvc) prodSvc.destroy();
        jest.clearAllTimers();
        jest.useRealTimers();
        process.env.NODE_ENV = oldEnv;
        if (oldTestMode !== undefined) global.__TEST_MODE__ = oldTestMode;
        Date.now = () => mockNow; // afterEach återställer till realDateNow
      }
    });
  });

  describe('getStatus — felsökningsvyn', () => {
    test('rapporterar antal fartyg, latches och ålder per latch', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      svc.registerPassage(MMSI, 'Järnvägsbron', 'north');
      svc.registerPassage(OTHER_MMSI, 'Stallbackabron', 'south');
      mockNow += 30 * 1000;

      const status = svc.getStatus();

      expect(status.vesselCount).toBe(2);
      expect(status.totalLatches).toBe(3);
      const first = status.latches.find((v) => v.vesselId === MMSI);
      expect(first.bridges).toHaveLength(2);
      expect(first.bridges[0]).toMatchObject({ direction: 'north', age: 30 * 1000 });
    });

    test('tom service rapporterar nollor', () => {
      expect(svc.getStatus()).toMatchObject({ vesselCount: 0, totalLatches: 0, latches: [] });
    });
  });

  describe('destroy — shutdown-städning', () => {
    test('destroy tömmer allt tillstånd och är idempotent', () => {
      svc.registerPassage(MMSI, 'Klaffbron', 'north');
      svc.registerPassage(OTHER_MMSI, 'Olidebron', 'south');

      svc.destroy();

      expect(svc.getStatus()).toMatchObject({ vesselCount: 0, totalLatches: 0 });
      expect(svc._cleanupTimer).toBeNull();
      expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting')).toBe(false);
      expect(() => svc.destroy()).not.toThrow();
    });
  });
});
