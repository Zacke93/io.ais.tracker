'use strict';

/**
 * Fable-granskningen 2026-08-10 — VesselDataService-fynden (FG-C1…C6).
 *
 * FG-C1 (bugg): _hasPassedTargetBridge:s dedupcache var nycklad
 *   `mmsi:targetBridge` med 500 ms TTL UTAN segmentidentitet. Syftet är
 *   memoisering inom SAMMA updateVessel-cykel (updateVessel och
 *   _handleTargetBridgeTransition anropar metoden med samma (vessel, oldVessel)-
 *   par), men i dubbelkälleläget 'both' kan två OLIKA meddelanden för samma
 *   fartyg landa <500 ms isär (hub-batchens synkrona emit + aisstream-pushen).
 *   Då svalde ett cachat NEGATIVT svar från meddelande N den ÄKTA
 *   linjekorsningen i meddelande N+1 — och eftersom den cachade negativa
 *   returnerar FÖRE GPS-gatens kandidatregistrering fanns inte ens
 *   kandidatspåret kvar som räddning. Fixen binder cacheposten till
 *   positionsparet (segKey).
 *
 * FG-C2 (bugg): _updateSpeedHistory MUTERADE oldHistory (push) och anropas TVÅ
 *   gånger per AIS-meddelande mot samma array (speedHistory + maxRecentSpeed).
 *   Andra anropet dubblerade därmed dagens sampel i 10-fönstret och kunde
 *   trycka ut det äldsta ÄKTA samplet i förtid.
 *
 * FG-C3 (latent bugg): ACCELERATED-grenens `return vessel;` vid ogiltig bro låg
 *   FÖRE this.vessels.set() och event-emitteringen → hela meddelandet tappades
 *   tyst medan anroparen loggade "Processed".
 *
 * FG-C4 (loggvolym): NEAR_MISS_PASSAGE skrevs ogatat på logger.log med
 *   JSON.stringify för VARJE meddelande inom 300 m av målbron utan passage.
 *
 * FG-C5 (död kod): shutdown(), getVesselsByTargetBridge() och clearCleanup()
 *   hade noll anropare i hela repot.
 *
 * FG-C6 (kommentar): "regardless of targetBridge" var falskt —
 *   _isVesselNearStallbackabron kräver själv targetBridge != null.
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

const KLAFF = BRIDGES.klaffbron;
const STALL = BRIDGES.stallbackabron;

// Tre positioner på Klaffbrons färdlinje: P0/P1 ligger NORR om bron (ingen
// korsning), P2 ligger SÖDER om den (äkta linjekorsning P1→P2).
const P0 = { lat: KLAFF.lat + 0.0007, lon: KLAFF.lon };
const P1 = { lat: KLAFF.lat + 0.00093, lon: KLAFF.lon + 0.0001 };
const P2 = { lat: KLAFF.lat - 0.00093, lon: KLAFF.lon - 0.0001 };

// MARY-fallets kajwobbelposition (300–500 m från Klaffbron) — samma fönster
// som C4b-testet använder för att nå ACCELERATED-vägen.
const MARY_WOBBEL = { lat: 58.28714, lon: 12.28560 };
const SYD_1 = { lat: 58.29061, lon: 12.29060 };
const SYD_2 = { lat: 58.28915, lon: 12.28854 };

const realDateNow = Date.now;

describe('Fable-granskningen 2026-08-10: VesselDataService', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;
  let mockNow;

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 7, 10, 12, 0, 0).getTime();
    Date.now = () => mockNow;

    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
    jest.restoreAllMocks();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  function advance(ms) {
    mockNow += ms;
  }

  function mkVessel(pos, extra = {}) {
    return {
      mmsi: '265999001',
      targetBridge: 'Klaffbron',
      lat: pos.lat,
      lon: pos.lon,
      sog: 3.5,
      cog: 200,
      ...extra,
    };
  }

  // ---------------------------------------------------------------------
  // FG-C1
  // ---------------------------------------------------------------------
  describe('FG-C1: passagecachen kräver segmentidentitet', () => {
    test('testets geometriska förutsättning: P0→P1 är ingen passage, P1→P2 är det', () => {
      // Utan den här kontrollen kan regressionstesterna nedan bli tomma om
      // geometrin någonsin ändras — då ska DE HÄR raderna falla först.
      const klaffbron = {
        name: 'Klaffbron', lat: KLAFF.lat, lon: KLAFF.lon, axisBearing: KLAFF.axisBearing,
      };
      expect(geometry.detectBridgePassage(
        mkVessel(P1, { sog: 0.4 }), mkVessel(P0, { sog: 0.5 }), klaffbron,
      ).passed).toBe(false);
      expect(geometry.detectBridgePassage(
        mkVessel(P2), mkVessel(P1), klaffbron,
      ).passed).toBe(true);
    });

    test('samma (vessel, oldVessel)-par två gånger <500 ms ⇒ andra anropet är cacheträff', () => {
      const spy = jest.spyOn(geometry, 'detectBridgePassage');
      const oldVessel = mkVessel(P0, { sog: 0.5 });
      const vessel = mkVessel(P1, { sog: 0.4 });

      const first = svc._hasPassedTargetBridge(vessel, oldVessel);
      advance(120);
      const second = svc._hasPassedTargetBridge(vessel, oldVessel);

      expect(first).toBe(false);
      expect(second).toBe(false);
      // Kärnan i FIX U: dubbelarbetet inom cykeln är fortfarande borta.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('cacheposten bär segmentnyckeln (positionsparet oldVessel→vessel)', () => {
      const oldVessel = mkVessel(P0, { sog: 0.5 });
      const vessel = mkVessel(P1, { sog: 0.4 });
      svc._hasPassedTargetBridge(vessel, oldVessel);

      const cached = svc._passageDetectionCache.get('265999001:Klaffbron');
      expect(cached.result).toBe(false);
      expect(cached.segKey).toBe(`${P0.lat},${P0.lon}:${P1.lat},${P1.lon}`);
    });

    test('REGRESSION: nytt segment <500 ms senare sväljs INTE av det cachade negativa svaret', () => {
      const spy = jest.spyOn(geometry, 'detectBridgePassage');

      // Meddelande N (hub-batchen): ingen passage → negativt svar cachas.
      expect(svc._hasPassedTargetBridge(mkVessel(P1, { sog: 0.4 }), mkVessel(P0, { sog: 0.5 })))
        .toBe(false);

      // Meddelande N+1 (aisstream-pushen) 180 ms senare: ÄKTA linjekorsning
      // P1→P2. Före FG-C1 returnerade cachen `false` här och passagen försvann.
      advance(180);
      const passed = svc._hasPassedTargetBridge(mkVessel(P2), mkVessel(P1));

      expect(passed).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      // Passagen fick alla sina sidoeffekter, inte bara returvärdet.
      expect(svc._passageDetectionCache.get('265999001:Klaffbron').result).toBe(true);
    });

    test('NARROWNESS: 500 ms-TTL:n är oförändrad — samma segment räknas om efter fönstret', () => {
      const spy = jest.spyOn(geometry, 'detectBridgePassage');
      const oldVessel = mkVessel(P0, { sog: 0.5 });
      const vessel = mkVessel(P1, { sog: 0.4 });

      svc._hasPassedTargetBridge(vessel, oldVessel);
      advance(600);
      svc._hasPassedTargetBridge(vessel, oldVessel);

      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------
  // FG-C2
  // ---------------------------------------------------------------------
  describe('FG-C2: _updateSpeedHistory muterar inte anroparens array', () => {
    /** Tio sampel där NÄST äldsta bär maxfarten — exakt den plats som den
     * dubbla pushen tryckte ut ur 10-fönstret. */
    function tenSampleWindowWithMaxAtIndex1() {
      const hist = [];
      for (let i = 0; i < 10; i += 1) {
        hist.push({ speed: i === 1 ? 9.9 : 3.0, timestamp: mockNow - (10 - i) * 1000 });
      }
      return hist;
    }

    test('metoden är ren: indata-arrayen är oförändrad, resultatet är en ny array', () => {
      const hist = [{ speed: 4.2, timestamp: mockNow - 1000 }];
      const out = svc._updateSpeedHistory(hist, 5.1);

      expect(hist).toHaveLength(1);
      expect(out).toHaveLength(2);
      expect(out).not.toBe(hist);
    });

    test('REGRESSION: de två anropen per meddelande ger samma 10-fönster (maxet överlever)', () => {
      const hist = tenSampleWindowWithMaxAtIndex1();

      // Speglar _createVesselObject ~:3835 + ~:3836: SAMMA array, två anrop.
      const stored = svc._updateSpeedHistory(hist, 1.0);
      const max = svc._calculateMaxRecentSpeed({ speedHistory: hist }, 1.0);

      expect(hist).toHaveLength(10); // ingen mutation
      expect(stored).toHaveLength(10);
      // Före FG-C2 sköt andra anropet ut TVÅ sampel (dagens låg dubbelt) och
      // maxRecentSpeed föll till 3.0 — transitfartsskattningen tappade toppen.
      expect(max).toBe(9.9);
      expect(Math.max(...stored.map((e) => e.speed))).toBe(9.9);
    });

    test('integration: updateVessel behåller maxRecentSpeed ur ett fullt 10-fönster', () => {
      const mmsi = '265999002';
      svc.updateVessel(mmsi, {
        lat: SYD_1.lat, lon: SYD_1.lon, sog: 3.0, cog: 212.1, name: 'HISTORIK',
      });
      const stored = svc.vessels.get(mmsi);
      stored.speedHistory = tenSampleWindowWithMaxAtIndex1();

      advance(1000);
      const v = svc.updateVessel(mmsi, {
        lat: SYD_2.lat, lon: SYD_2.lon, sog: 1.0, cog: 219.6, name: 'HISTORIK',
      });

      expect(v.speedHistory).toHaveLength(10);
      expect(v.maxRecentSpeed).toBe(9.9);
    });
  });

  // ---------------------------------------------------------------------
  // FG-C3
  // ---------------------------------------------------------------------
  describe('FG-C3: ogiltig bro i ACCELERATED-vägen tappar inte meddelandet', () => {
    const MMSI = '219028537';

    /** Sydgående i fart (lås 'south' + rörelsebevis) → MOORED_DEMOTE, dvs.
     * exakt utgångsläget för ACCELERATED-återpromoveringen. */
    function seedSouthboundThenDemote() {
      svc.updateVessel(MMSI, {
        lat: SYD_1.lat, lon: SYD_1.lon, sog: 3.6, cog: 212.1, name: 'MARY',
      });
      advance(60 * 1000);
      svc.updateVessel(MMSI, {
        lat: SYD_2.lat, lon: SYD_2.lon, sog: 3.5, cog: 219.6, name: 'MARY',
      });
      const stored = svc.vessels.get(MMSI);
      stored.targetBridge = null;
      stored._pendingTarget = null;
      advance(5 * 60 * 1000);
      return stored;
    }

    /**
     * Gör målbron ogiltig ENBART i ACCELERATED-grenens uppslag. Grinden måste
     * öppnas efter _calculateTargetBridge, eftersom den metoden själv slår upp
     * Klaffbron/Stridsbergsbron och skulle returnera null (och därmed aldrig nå
     * den gren vi testar) om uppslaget var trasigt redan där.
     */
    function breakBridgeLookupAfterTargetCalculation() {
      const realCalc = svc._calculateTargetBridge.bind(svc);
      const realGet = svc.bridgeRegistry.getBridgeByName.bind(svc.bridgeRegistry);
      let armed = false;
      svc._calculateTargetBridge = (v) => {
        const name = realCalc(v);
        armed = true;
        return name;
      };
      svc.bridgeRegistry.getBridgeByName = (name) => (
        armed && name === 'Klaffbron'
          ? { name: 'Klaffbron', lat: NaN, lon: NaN } // ogiltiga koordinater
          : realGet(name)
      );
    }

    test('fartyget lagras och event emitteras trots ogiltig bro (inget tyst tapp)', () => {
      const before = seedSouthboundThenDemote();
      const beforeLat = before.lat;
      const updated = jest.fn();
      svc.on('vessel:updated', updated);

      breakBridgeLookupAfterTargetCalculation();

      const v = svc.updateVessel(MMSI, {
        lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 0.6, cog: 354.9, name: 'MARY',
      });

      // 1. Felet loggades (grenen togs verkligen).
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('not found or has invalid coordinates'),
      );
      // 2. Meddelandet gick HELA vägen: lagring …
      expect(v).not.toBeNull();
      expect(svc.vessels.get(MMSI)).toBe(v);
      expect(svc.vessels.get(MMSI).lat).toBe(MARY_WOBBEL.lat);
      expect(svc.vessels.get(MMSI).lat).not.toBe(beforeLat);
      // 3. … och event-emittering.
      expect(updated).toHaveBeenCalledTimes(1);
      expect(updated.mock.calls[0][0].mmsi).toBe(MMSI);
      // 4. Måltilldelningen — och bara den — hoppades över.
      expect(v.targetBridge).toBeNull();
    });

    test('kontrapositiv: med giltig bro tilldelas målbron precis som förut', () => {
      seedSouthboundThenDemote();
      const v = svc.updateVessel(MMSI, {
        lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 0.6, cog: 354.9, name: 'MARY',
      });
      expect(v.targetBridge).toBe('Klaffbron');
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // FG-C4
  // ---------------------------------------------------------------------
  describe('FG-C4: NEAR_MISS_PASSAGE debouncas per (mmsi, målbro)', () => {
    function nearMissLines() {
      return logger.log.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('[NEAR_MISS_PASSAGE]'));
    }

    /** Kör N nära-bron-uppdateringar utan passage. Varje anrop får ETT eget
     * segment (annars kortsluter FG-C1:s cache och testet mäter fel sak). */
    function replayNearMisses(count, gapMs) {
      for (let i = 0; i < count; i += 1) {
        const jitter = i * 0.000002;
        svc._hasPassedTargetBridge(
          mkVessel({ lat: P1.lat + jitter, lon: P1.lon }, { sog: 0.4 }),
          mkVessel({ lat: P0.lat + jitter, lon: P0.lon }, { sog: 0.5 }),
        );
        advance(gapMs);
      }
    }

    test('en kajliggare vid bron ger EN rad per 3-minutersfönster, inte en per meddelande', () => {
      replayNearMisses(20, 10 * 1000); // 20 meddelanden på ~3,3 min

      const lines = nearMissLines();
      // Före FG-C4: 20 rader (med JSON.stringify-detaljer i varje).
      expect(lines).toHaveLength(2); // t=0 och första meddelandet efter 3 min
      expect(lines[0]).toContain('(repeats suppressed: 0)');
      // Andra raden redovisar de undertryckta förekomsterna däremellan.
      expect(lines[1]).toMatch(/\(repeats suppressed: 1[0-9]\)/);
    });

    test('nyckeln är per fartyg och målbro — ett annat fartyg tystas inte', () => {
      replayNearMisses(3, 1000);
      svc._hasPassedTargetBridge(
        mkVessel(P1, { mmsi: '265999009', sog: 0.4 }),
        mkVessel(P0, { mmsi: '265999009', sog: 0.5 }),
      );

      const lines = nearMissLines();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('265999009');
      expect(svc._logDebounce.has('nearMiss:265999009:Klaffbron')).toBe(true);
    });

    test('nycklarna släpps när fartyget tas bort — ingen läcka i _logDebounce', () => {
      // Replay-invarianten kräver `logDebounce=0` efter efterspelet. Den
      // per-fartygs-städning som redan fanns matchade mmsi som SUFFIX
      // (`noTarget:<mmsi>`) och missade den bro-suffixade nearMiss-nyckeln —
      // fångat av 17 låsta korpusar innan fixen landade.
      const mmsi = '265999004';
      svc.updateVessel(mmsi, {
        lat: SYD_1.lat, lon: SYD_1.lon, sog: 3.6, cog: 212.1, name: 'LÄCKTEST',
      });
      svc._logDebounce.set(`nearMiss:${mmsi}:Klaffbron`, mockNow);
      svc._logRepeatCount.set(`nearMiss:${mmsi}:Klaffbron`, 4);
      svc._logDebounce.set(`noTarget:${mmsi}`, mockNow);
      svc._logRepeatCount.set(`noTarget:${mmsi}`, 2);

      svc.removeVessel(mmsi, 'test-cleanup');

      expect(svc._logDebounce.size).toBe(0);
      expect(svc._logRepeatCount.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // FG-C5 / FG-C6
  // ---------------------------------------------------------------------
  describe('FG-C5: död kod är borttagen', () => {
    test('shutdown/getVesselsByTargetBridge/clearCleanup finns inte kvar', () => {
      // Verifierat med grep över app.js, lib/, drivers/ och tests/: enda
      // träffen var definitionen. app.js städar via clearAllTimers().
      expect(svc.shutdown).toBeUndefined();
      expect(svc.getVesselsByTargetBridge).toBeUndefined();
      expect(svc.clearCleanup).toBeUndefined();
      // Den väg som faktiskt används finns kvar.
      expect(typeof svc.clearAllTimers).toBe('function');
      expect(typeof svc._clearCleanupTimer).toBe('function');
    });
  });

  describe('FG-C6: Stallbacka-termen kan inte rädda ett mållöst fartyg', () => {
    const nearStallbacka = {
      mmsi: '265999003',
      lat: STALL.lat,
      lon: STALL.lon,
      status: 'approaching',
    };

    test('utan targetBridge → false (kommentarens "regardless of targetBridge" var falsk)', () => {
      expect(svc._isVesselNearStallbackabron({ ...nearStallbacka, targetBridge: null }))
        .toBe(false);
    });

    test('med targetBridge → true (villkoret behålls som defense-in-depth)', () => {
      expect(svc._isVesselNearStallbackabron({ ...nearStallbacka, targetBridge: 'Stridsbergsbron' }))
        .toBe(true);
    });
  });
});
