'use strict';

/**
 * J10 / K19 — RÖRELSERIMLIGHETENS DELADE FORMEL.
 *
 * BAKGRUND. Samma fråga ("hur långt får ett fartyg rimligen ha flyttat sig?")
 * ställdes på tre ställen med tre kopior av samma uttryck. K19 (fältprov 10)
 * tidsnormaliserade VesselDataService._detectGPSEventProtection men lämnade
 * SystemCoordinator.coordinatePositionUpdate med sin nakna meter-tröskel —
 * matad av EXAKT samma analysis.movementDistance. Ett naket avståndsvillkor
 * mäter LEVERANSKADENS, inte fysik: vid AISHubs fix-Δ (p50 152 s) motsvarar
 * 300 m bara 3,9 kn, alltså vanlig kanalfart.
 *
 * VAD SOM FAKTISKT LEVERERADES (fixomgång B, 2026-08-22):
 *   • Formeln bor i lib/utils/movementPlausibility och är INKOPPLAD på K19:s
 *     eget anropsställe — kopian där är borttagen. Flytten är beteendeneutral,
 *     bevisad med replayRunner ON/OFF över ALLA 18 korpusar: text-, notis- och
 *     öppningsströmmarna är byte-identiska.
 *   • SystemCoordinators gren är PRÖVAD OCH ÅTERTAGEN. Omkopplingen var
 *     mekaniskt riktig men tar samtidigt bort en TEXTDÄMPNING som i dag
 *     maskerar en ETA-defekt: i korpus 20260712-25h publicerar appen då
 *     "En båt på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter"
 *     16:45:25 för FRAM 211864690 — som stannade 16:42:53 på 886 m från bron,
 *     låg kvar med sog 0 i över fyra timmar och ALDRIG korsade den (hon saknas
 *     i gt-passages). Rotorsaken ligger i ProgressiveETACalculator; se
 *     tests/j10b-eta-passagegolvet-stillaliggande.test.js.
 *
 * SVITEN LÅSER, i den ordningen:
 *   1. Hjärtat: hjälparen ger IDENTISKT svar med K19:s borttagna kopia
 *      (referensimplementationen står i testet) över ett svep av tidsbaser,
 *      farter och objektformer.
 *   2. Produktionens TVÅ objektformer — den fulla vessel-formen K19 får, och
 *      den SYNTETISKA currentVessel-formen (utan lastPositionUpdate) som
 *      coordinatePositionUpdate får, så en framtida J10-omtagning inte behöver
 *      upptäcka formskillnaden på nytt.
 *   3. K19 GENOM RIKTIG PIPELINE: två VesselDataService.updateVessel över
 *      AISHub-kadens, inga handsatta fält.
 *   4. Att SystemCoordinators gren är avsiktligt naken (karakterisering).
 *   5. GOLVVAKTEN (L20, runda 3): ett ogiltigt golvargument gör grinden
 *      STRÄNGARE, aldrig osynlig. Modulen föll förut tyst öppen på NaN.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const {
  assessMovement, allowedMovement, movementTimeBaseMs,
  MOVEMENT_MARGIN_FACTOR, SPEED_FLOOR_BOTH_SOG_KN, SPEED_FLOOR_MISSING_SOG_KN,
} = require('../lib/utils/movementPlausibility');
const { BRIDGES } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// Fältets egen kadens: AISHubs fix-Δ p50 är 152 s. 400 m på den tiden är
// 5,05 kn — vanlig kanalfart, exakt den klass mätningen fann.
const KADENS_MS = 152000;
// K19:s eget golv. SystemCoordinators motsvarande gren står på 300 m; de är
// medvetet olika eftersom var och en bevarar sitt anropsställes historik.
const K19_GOLV_M = 200;

/**
 * REFERENSIMPLEMENTATION — K19:s kopia ORDAGRANT som den stod i
 * VesselDataService._detectGPSEventProtection innan den byttes mot hjälparen.
 * Den finns här som ORAKEL: hjälparen måste ge samma svar för varje indata,
 * annars var flytten inte beteendeneutral. Muteras hjälparen (t.ex. marginal
 * 2,0 → 1,0, golvet borttaget, tidsbasvakten borttagen) faller identitets-
 * testet omedelbart.
 */
function k19Referens(vessel, oldVessel, golvM) {
  const fixDtMs = GPSJumpAnalyzer.fixDtMs(vessel, oldVessel);
  const nowTs = Math.max(vessel.lastPositionUpdate || 0, vessel.timestamp || 0);
  const prevTs = Math.max(oldVessel.lastPositionUpdate || 0, oldVessel.timestamp || 0);
  const receiveDtMs = (nowTs > 0 && prevTs > 0) ? (nowTs - prevTs) : null;
  const dtMs = fixDtMs !== null ? fixDtMs : receiveDtMs;
  let allowedMovementM = golvM;
  if (Number.isFinite(dtMs) && dtMs > 0) {
    const oldSog = Number.isFinite(oldVessel.sog) ? oldVessel.sog : null;
    const newSog = Number.isFinite(vessel.sog) ? vessel.sog : null;
    const knownMaxSog = Math.max(oldSog ?? 0, newSog ?? 0);
    const speedFloorKn = (oldSog === null || newSog === null)
      ? Math.max(knownMaxSog, 5)
      : Math.max(knownMaxSog, 1);
    allowedMovementM = Math.max(golvM, speedFloorKn * 1852 * (dtMs / 3600000) * 2.0);
  }
  return allowedMovementM;
}

describe('J10/K19 (1): hjälparen är ORDAGRANT K19:s formel', () => {
  test('IDENTITETSBEVISET: hjälparen och referensen ger samma tak för varje indata', () => {
    const nu = 1_700_000_000_000;
    const dtar = [-60000, 0, 1, 1000, 10000, 152000, 570000, 3600000];
    const sogar = [null, 0, 0.4, 1, 5.2, 12, 30];
    let kombinationer = 0;

    for (const dt of dtar) {
      for (const nySog of sogar) {
        for (const gammalSog of sogar) {
          // Full produktionsform (K19:s egen): båda sidor bär fixklocka OCH
          // mottagningsklocka.
          const v = {
            sog: nySog, timestamp: nu, lastPositionUpdate: nu, fixTs: nu, fixFeed: 'aishub',
          };
          const o = {
            sog: gammalSog,
            timestamp: nu - dt,
            lastPositionUpdate: nu - dt,
            fixTs: nu - dt,
            fixFeed: 'aishub',
          };
          expect(allowedMovement(v, o, K19_GOLV_M).allowedM)
            .toBe(k19Referens(v, o, K19_GOLV_M));

          // Utan fixklocka ⇒ mottagnings-Δ:n ska ta över, samma på båda sidor.
          const v2 = { sog: nySog, timestamp: nu, lastPositionUpdate: nu };
          const o2 = { sog: gammalSog, timestamp: nu - dt, lastPositionUpdate: nu - dt };
          expect(allowedMovement(v2, o2, K19_GOLV_M).allowedM)
            .toBe(k19Referens(v2, o2, K19_GOLV_M));
          kombinationer += 2;
        }
      }
    }
    expect(kombinationer).toBe(dtar.length * sogar.length * sogar.length * 2);
  });

  test('TALEN: marginal 2,0 och fartgolven 1 kn / 5 kn är oförändrade', () => {
    expect(MOVEMENT_MARGIN_FACTOR).toBe(2.0);
    expect(SPEED_FLOOR_BOTH_SOG_KN).toBe(1);
    expect(SPEED_FLOOR_MISSING_SOG_KN).toBe(5);

    const nu = 1_700_000_000_000;
    const v = { sog: 5.2, timestamp: nu };
    const o = { sog: 5.2, timestamp: nu - KADENS_MS };
    const vantat = 5.2 * 1852 * (KADENS_MS / 3600000) * MOVEMENT_MARGIN_FACTOR;
    expect(allowedMovement(v, o, K19_GOLV_M).allowedM).toBeCloseTo(vantat, 6);
    // Just därför släpps fältets 400 m på 152 s igenom.
    expect(vantat).toBeGreaterThan(400);
  });

  test('GJ-2-LÄXAN: ensidigt saknad sog ger 5 kn-golv, inte 0', () => {
    const nu = 1_700_000_000_000;
    const { speedFloorKn } = allowedMovement(
      { sog: null, timestamp: nu }, { sog: 0, timestamp: nu - KADENS_MS }, K19_GOLV_M,
    );
    expect(speedFloorKn).toBe(SPEED_FLOOR_MISSING_SOG_KN);
  });

  test('FAIL-OPEN STÄNGD: saknad tidsstämpel på EN sida ⇒ golvet, inte epoken', () => {
    const nu = 1_700_000_000_000;
    // Utan tidsbasvakten blev dt hela epoken och taket ~9·10⁹ m ⇒ grinden
    // kunde ALDRIG slå till.
    const { allowedM, dtSource } = allowedMovement(
      { sog: 5, timestamp: nu }, { sog: 5 }, K19_GOLV_M,
    );
    expect(dtSource).toBe('none');
    expect(allowedM).toBe(K19_GOLV_M);
  });

  test('ENDAST STRÄNGARE: taket underskrider aldrig anropsställets golv', () => {
    const nu = 1_700_000_000_000;
    for (const dt of [-1, 0, 1, 1000, 10000, 152000, 570000]) {
      for (const sog of [0, 0.4, 5.2, 12]) {
        for (const golv of [K19_GOLV_M, 300]) {
          const { allowedM } = allowedMovement(
            { sog, timestamp: nu }, { sog, timestamp: nu - dt }, golv,
          );
          expect(allowedM).toBeGreaterThanOrEqual(golv);
        }
      }
    }
  });

  test('assessMovement flaggar bara det som faktiskt överstiger taket', () => {
    const nu = 1_700_000_000_000;
    const v = { sog: 5.2, timestamp: nu };
    const o = { sog: 5.2, timestamp: nu - KADENS_MS };
    expect(assessMovement(400, v, o, 300).implausible).toBe(false);
    expect(assessMovement(900, v, o, 300).implausible).toBe(true);
    expect(assessMovement(undefined, v, o, 300).implausible).toBe(false);
  });
});

describe('J10/K19 (2): produktionens TVÅ objektformer', () => {
  const nu = 1_700_000_000_000;

  test('K19:s form (full vessel, lastPositionUpdate + timestamp + fixTs/fixFeed)', () => {
    // Så ser objekten ut som _checkTargetBridgeProtection skickar vidare: båda
    // kommer ur this.vessels-kartan och bär hela fältuppsättningen.
    const vessel = {
      sog: 5.2,
      lastPositionUpdate: nu,
      timestamp: nu,
      fixTs: nu,
      fixFeed: 'aishub',
    };
    const oldVessel = {
      sog: 4.9,
      lastPositionUpdate: nu - KADENS_MS,
      timestamp: nu - KADENS_MS,
      fixTs: nu - KADENS_MS,
      fixFeed: 'aishub',
    };
    const { dtMs, source } = movementTimeBaseMs(vessel, oldVessel);
    expect(source).toBe('fix');
    expect(dtMs).toBe(KADENS_MS);
    expect(assessMovement(400, vessel, oldVessel, K19_GOLV_M).implausible).toBe(false);
  });

  test('coordinatePositionUpdates form: SYNTETISKT currentVessel UTAN lastPositionUpdate', () => {
    // VesselDataService bygger ett eget litet objekt till koordinatorn
    // (cog/sog/timestamp = Date.now()/fixTs/fixFeed/feedSwitch). Fältet
    // lastPositionUpdate finns INTE där — bara på oldVessel-sidan. Formen
    // låses här så en framtida J10-omtagning inte behöver upptäcka den igen.
    const currentVessel = {
      cog: 18.4,
      sog: 5.2,
      timestamp: nu,
      fixTs: nu,
      fixFeed: 'aishub',
      feedSwitch: false,
    };
    const oldVessel = {
      sog: 4.9,
      lastPositionUpdate: nu - KADENS_MS,
      timestamp: nu - KADENS_MS,
      fixTs: nu - KADENS_MS,
      fixFeed: 'aishub',
    };
    expect(currentVessel.lastPositionUpdate).toBeUndefined();

    // Fixklockan bär formen — den bryr sig inte om lastPositionUpdate.
    expect(movementTimeBaseMs(currentVessel, oldVessel)).toEqual({
      dtMs: KADENS_MS, source: 'fix',
    });
    expect(assessMovement(400, currentVessel, oldVessel, 300).implausible).toBe(false);

    // ...och UTAN fixklocka faller den tillbaka på mottagningstiden, där
    // `timestamp` ensam räcker på den syntetiska sidan.
    const utanFix = { cog: 18.4, sog: 5.2, timestamp: nu };
    const gammalUtanFix = { sog: 4.9, lastPositionUpdate: nu - KADENS_MS, timestamp: nu - KADENS_MS };
    expect(movementTimeBaseMs(utanFix, gammalUtanFix)).toEqual({
      dtMs: KADENS_MS, source: 'receive',
    });
  });
});

describe('J10/K19 (3): K19-grinden genom RIKTIG pipeline', () => {
  const liveServices = [];
  let nu;

  const makeVDS = () => {
    const svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    liveServices.push(svc);
    return svc;
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

  /**
   * Två RIKTIGA AIS-uppdateringar söder om Klaffbron, samma kurs (så
   * manövergrinden inte kan förklara utfallet) och långt utanför brons
   * 300 m-skyddszon (så avståndsgrinden inte heller kan det). Enda variabeln
   * är LEVERANSKADENSEN mellan de två samplen.
   */
  const koerTvaSampel = (svc, mmsi, dtMs, metrar) => {
    const startLat = BRIDGES.klaffbron.lat - 0.0135; // ~1500 m söder om bron
    svc.updateVessel(mmsi, {
      mmsi, lat: startLat, lon: BRIDGES.klaffbron.lon, sog: 5.2, cog: 20, name: 'K19-PROV', fixFeed: 'aishub', fixTs: nu,
    });
    const foreSample = { ...svc.vessels.get(mmsi) };
    nu += dtMs;
    svc.updateVessel(mmsi, {
      mmsi,
      lat: startLat + metrar / 111320,
      lon: BRIDGES.klaffbron.lon,
      sog: 5.2,
      cog: 20,
      name: 'K19-PROV',
      fixFeed: 'aishub',
      fixTs: nu,
    });
    return { vessel: svc.vessels.get(mmsi), oldVessel: foreSample };
  };

  test('KÄRNAN: 400 m på 152 s i 5,2 kn ger INGEN gps-event-flagga', () => {
    const svc = makeVDS();
    const { vessel, oldVessel } = koerTvaSampel(svc, '265111222', KADENS_MS, 400);

    // Pipelinen måste ha tagit sig hela vägen till målbrotilldelningen,
    // annars provar testet ingenting (skyddet kräver targetBridge).
    expect(vessel.targetBridge).toBe('Klaffbron');

    const skydd = svc.targetBridgeProtection.get('265111222');
    // Antingen finns inget skydd alls, eller så är det aktiverat av något
    // ANNAT än gps-event — men aldrig av rörelsen.
    expect(skydd === undefined || skydd.gpsEventDetected === false).toBe(true);

    // ...och grinden själv, matad med produktionens EGNA objekt, säger samma
    // sak: taket vid den här kadensen är 813 m, alltså vida över 400.
    expect(svc._detectGPSEventProtection(vessel, oldVessel)).toBe(false);
    expect(allowedMovement(vessel, oldVessel, K19_GOLV_M).allowedM).toBeGreaterThan(400);
  });

  test('KONTRASTEN: samma 400 m på 10 s ÄR fysikaliskt orimligt', () => {
    const svc = makeVDS();
    const { vessel, oldVessel } = koerTvaSampel(svc, '265111223', 10000, 400);

    const skydd = svc.targetBridgeProtection.get('265111223');
    expect(skydd).toBeDefined();
    expect(skydd.gpsEventDetected).toBe(true);
    // Och K19:s eget tak är överskridet, inte bara analysatorns: 5,2 kn på
    // 10 s ger 54 m fysikaliskt ⇒ 200 m-golvet gäller, och 400 > 200.
    expect(allowedMovement(vessel, oldVessel, K19_GOLV_M).allowedM).toBe(K19_GOLV_M);
  });

  /**
   * Bygger ETT produktionsobjekt genom RIKTIG updateVessel på ett FÄRSKT
   * fartyg (ingen tidigare position ⇒ analysatorn sätter inga flaggor, precis
   * som för första samplet i drift). Två sådana objekt ger K19-grenen ett par
   * där varenda fält är byggt av _createVesselObject — inga handsatta värden.
   */
  const byggProduktionsobjekt = (mmsi, latOffsetM, tidsOffsetMs) => {
    const svc = makeVDS();
    nu += tidsOffsetMs;
    svc.updateVessel(mmsi, {
      mmsi,
      lat: BRIDGES.klaffbron.lat - 0.0135 + latOffsetM / 111320,
      lon: BRIDGES.klaffbron.lon,
      sog: 5.2,
      cog: 20,
      name: 'K19-PROV',
      fixFeed: 'aishub',
      fixTs: nu,
    });
    const objekt = svc.vessels.get(mmsi);
    expect(objekt._gpsJumpDetected).toBeFalsy();
    expect(objekt._positionUncertain).toBeFalsy();
    return { svc, objekt };
  };

  test('K19-GRENEN ISOLERAD: samma 400 m, bara kadensen skiljer', () => {
    // FÖRSTA sampel-paret: 152 s isär ⇒ taket 813 m ⇒ rimligt.
    const a = byggProduktionsobjekt('265111230', 0, 0);
    const b = byggProduktionsobjekt('265111231', 400, KADENS_MS);
    expect(a.svc._detectGPSEventProtection(b.objekt, a.objekt)).toBe(false);

    // ANDRA paret: identisk geometri, men levererat 10 s isär ⇒ 5,2 kn ger
    // 54 m fysikaliskt, golvet 200 m gäller, och 400 > 200 ⇒ orimligt.
    const c = byggProduktionsobjekt('265111232', 0, 0);
    const d = byggProduktionsobjekt('265111233', 400, 10000);
    expect(c.svc._detectGPSEventProtection(d.objekt, c.objekt)).toBe(true);

    // Och GOLVET lever: 150 m på samma 10 s är under 200 m ⇒ rimligt.
    const e = byggProduktionsobjekt('265111234', 0, 0);
    const f = byggProduktionsobjekt('265111235', 150, 10000);
    expect(e.svc._detectGPSEventProtection(f.objekt, e.objekt)).toBe(false);
  });

  test('DOKUMENTERAD SANNING: K19 kan aldrig vara STRÄNGARE än analysatorn', () => {
    // Varför K19-omskrivningen mätte NOLL ändrade replayutfall: GPSJumpAnalyzers
    // medium-gren (:186-205) bär EXAKT samma uttryck — maxfart × tid × 2,0 —
    // fast UTAN 200 m-golvet, och den sätter _positionUncertain innan K19 hinner
    // titta. K19:s tredje kontroll är alltså bara nåbar när analysatorn redan
    // accepterat, och då är den per konstruktion tystare (golvet lyfter taket).
    // Invarianten låses här så att en framtida skärpning av K19 (t.ex. marginal
    // 2,0 → 1,0) syns som ett RÖTT test i stället för som en tyst ny gate.
    const nu2 = 1_700_000_000_000;
    for (const dt of [1000, 10000, 60000, 152000, 570000]) {
      for (const sog of [0, 1, 5.2, 12]) {
        const v = {
          sog, timestamp: nu2, lastPositionUpdate: nu2, fixTs: nu2, fixFeed: 'aishub',
        };
        const o = {
          sog,
          timestamp: nu2 - dt,
          lastPositionUpdate: nu2 - dt,
          fixTs: nu2 - dt,
          fixFeed: 'aishub',
        };
        const analysatorTak = Math.max(sog, 1) * (dt / 3600000) * 2.0 * 1852;
        // FLYTTALSMARGINALEN (1 nm = 1e-9 m): de två uttrycken multiplicerar
        // samma faktorer i olika ORDNING (analysatorn kn × h × 2 × 1852,
        // hjälparen kn × 1852 × h × 2), vilket ger sista-biten-skillnader som
        // 740,8 mot 740,8000000000001. Invarianten gäller storleksordningen,
        // inte flyttalsrepresentationen.
        expect(allowedMovement(v, o, K19_GOLV_M).allowedM)
          .toBeGreaterThanOrEqual(analysatorTak - 1e-9);
      }
    }
  });
});

describe('J10/K19 (4): SystemCoordinators gren är AVSIKTLIGT naken', () => {
  // KARAKTERISERING, inte ett önskemål. J10 (samma formel med golvet 300 m)
  // är prövad och återtagen — se kommentaren i SystemCoordinator och
  // tests/j10b-eta-passagegolvet-stillaliggande.test.js. Testet finns för att
  // en omtagning ska vara ett MEDVETET beslut med ett rött test framför sig,
  // inte en tyst ändring. Vänd på förväntan i samma commit som fixen.
  let sc;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    sc = new SystemCoordinator(makeLogger());
  });

  afterEach(() => {
    delete global.__TEST_MODE__;
  });

  test('400 m på 152 s i 5,2 kn ger fortfarande large_movement_coordination', () => {
    const nu = 1_700_000_000_000;
    const vessel = {
      sog: 5.2, timestamp: nu, fixTs: nu, fixFeed: 'aishub',
    };
    const oldVessel = {
      sog: 5.2,
      timestamp: nu - KADENS_MS,
      lastPositionUpdate: nu - KADENS_MS,
      fixTs: nu - KADENS_MS,
      fixFeed: 'aishub',
    };
    const rec = sc.coordinatePositionUpdate(
      '265111225', { isGPSJump: false, action: 'accept', movementDistance: 400 }, vessel, oldVessel,
    );

    expect(rec.reason).toBe('large_movement_coordination');
    expect(rec.coordinationActive).toBe(true);
    // Det är den HÄR flaggan som maskerar ETA-defekten i 20260712-25h.
    expect(rec.shouldDebounceText).toBe(true);
  });

  test('under 300 m händer ingenting, precis som förut', () => {
    const rec = sc.coordinatePositionUpdate(
      '265111226', { isGPSJump: false, action: 'accept', movementDistance: 299 }, {}, {},
    );
    expect(rec.reason).toBe('normal_operation');
  });
});

describe('J10/K19 (5): GOLVVAKTEN — ett ogiltigt golv stänger grinden, öppnar den inte', () => {
  // L20 (helkodsgranskning runda 3, 2026-08-22). Golvargumentet validerades
  // inte: Math.max(undefined, fysiskt) = NaN, och `förflyttning > NaN` är
  // ALLTID falsk ⇒ grinden försvann TYST. Nod-probe mot produktionsmodulen
  // före fixen: 100 km på 1 sekund med odefinierat golv bedömdes RIMLIG, med
  // golvet 200 orimlig. Två planerade konsumenter står på tur (J10 golv 300,
  // GPSJumpGateService golv 200), så vakten ska stå INNAN de kopplas in.
  const nu = 1_700_000_000_000;
  // 100 km på 1 sekund — 194 400 kn. Ingen tänkbar formel får kalla det rimligt.
  const OMOJLIG_M = 100000;
  const v = { sog: 5, timestamp: nu, lastPositionUpdate: nu };
  const o = { sog: 5, timestamp: nu - 1000, lastPositionUpdate: nu - 1000 };
  // Samma äldre sampel UTAN tidsstämpel ⇒ tidsbasvakten ger dtSource 'none'
  // och den tidiga returen lämnar tillbaka golvet orört. Det är den ANDRA
  // fail-open-vägen: där räckte undefined för att öppna grinden helt utan
  // NaN-aritmetik.
  const oUtanTid = { sog: 5 };

  test.each([
    ['undefined', undefined],
    ['NaN', NaN],
  ])('EXAKT det ogiltiga golvet (%s) ⇒ 100 km på 1 s är ORIMLIG, inte rimlig', (_namn, golv) => {
    const medTid = assessMovement(OMOJLIG_M, v, o, golv);
    expect(Number.isFinite(medTid.allowedM)).toBe(true); // före fixen: NaN
    expect(medTid.implausible).toBe(true); // före fixen: false

    // Andra vägen: ingen giltig tidsbas ⇒ tidiga returen.
    const utanTid = assessMovement(OMOJLIG_M, v, oUtanTid, golv);
    expect(utanTid.dtSource).toBe('none');
    expect(utanTid.allowedM).toBe(0); // före fixen: undefined/NaN
    expect(utanTid.implausible).toBe(true); // före fixen: false
  });

  test('FAIL-CLOSED, inte ett gissat standardgolv: taket blir det rent fysikaliska', () => {
    // Vakten sätter 0, alltså strängast möjliga variant av SAMMA regel —
    // maxfart × tid × marginal utan golv. Ett gissat standardgolv (t.ex. 200)
    // hade dolt felkopplingen i stället för att visa den.
    const fysiskt = 5 * 1852 * (1000 / 3600000) * MOVEMENT_MARGIN_FACTOR;
    expect(allowedMovement(v, o, undefined).allowedM).toBeCloseTo(fysiskt, 9);
    expect(allowedMovement(v, o, undefined).allowedM).toBe(allowedMovement(v, o, 0).allowedM);
  });

  test('NULL VAR REDAN OFARLIGT och ändras inte: Math.max koercerar det till 0', () => {
    // Skrivet uttryckligen — L20:s titel talar om "ogiltigt golv", men det är
    // BARA undefined och NaN som öppnade grinden. null betedde sig som 0 både
    // före och efter fixen, och det ska synas att den slutsatsen är prövad.
    expect(allowedMovement(v, o, null).allowedM).toBe(allowedMovement(v, o, 0).allowedM);
    expect(assessMovement(OMOJLIG_M, v, o, null).implausible).toBe(true);
    // Även på den tidsbaslösa vägen: `x > null` är `x > 0`.
    expect(assessMovement(OMOJLIG_M, v, oUtanTid, null).implausible).toBe(true);
  });

  test('NEGATIVA GOLV normaliseras till 0 — ett negativt tak betyder ingenting', () => {
    // Utan vakten gav den tidsbaslösa vägen allowedM = −50, dvs. VARJE
    // förflyttning (även 0 m) blev orimlig. Fail-closed, men på ett värde utan
    // innebörd; 0 är samma riktning med ett tal som går att resonera om.
    expect(allowedMovement(v, oUtanTid, -50).allowedM).toBe(0);
    expect(assessMovement(0, v, oUtanTid, -50).implausible).toBe(false);
    expect(assessMovement(1, v, oUtanTid, -50).implausible).toBe(true);
  });

  test('STRÄNGT TALKRAV: ett numeriskt STRÄNG-golv räknas som ogiltigt', () => {
    // Före fixen koercerade Math.max('200', x) tyst. Vakten kräver ett äkta
    // tal, så en anropare som skickar konfigsträngar får se det direkt
    // (grinden blir strängare) i stället för att flyta med i tysthet.
    expect(allowedMovement(v, oUtanTid, '200').allowedM).toBe(0);
    expect(allowedMovement(v, o, '200').allowedM).toBe(allowedMovement(v, o, 0).allowedM);
  });

  test('REGRESSIONSVAKT: allowedM är ALLTID ett finit tal — hela golvsvepet', () => {
    // Den generella formen av felet: vilken väg som helst som låter ett
    // icke-tal nå Math.max ger NaN, och NaN gör grinden osynlig. Svepet täcker
    // båda tidsbasvägarna och alla golvformer som setts i granskningen.
    const golv = [0, 1, 200, 300, null, undefined, NaN, -50, '200', Infinity, -Infinity, {}];
    const parList = [
      [v, o], [v, oUtanTid], [{ sog: null, timestamp: nu }, { sog: null, timestamp: nu - 152000 }],
    ];
    for (const g of golv) {
      for (const [ny, gammal] of parList) {
        const r = assessMovement(OMOJLIG_M, ny, gammal, g);
        expect(Number.isFinite(r.allowedM)).toBe(true);
        expect(r.implausible).toBe(true); // 100 km på ≤ 152 s: aldrig rimligt
      }
    }
  });

  test('PRODUKTIONSNEUTRALT: giltiga golv ger EXAKT samma tak som före vakten', () => {
    // Enda levande anroparen skickar literalen 200
    // (VesselDataService._detectGPSEventProtection). Referensimplementationen
    // överst i filen är K19:s kopia ORDAGRANT — vakten får inte flytta ett
    // enda av dess svar för ett giltigt golv.
    for (const golv of [0, 1, 200, 300, 1000]) {
      for (const dt of [-60000, 0, 1, 1000, 10000, KADENS_MS, 570000]) {
        for (const sog of [null, 0, 5.2, 12]) {
          const ny = { sog, timestamp: nu, lastPositionUpdate: nu };
          const gammal = { sog, timestamp: nu - dt, lastPositionUpdate: nu - dt };
          expect(allowedMovement(ny, gammal, golv).allowedM)
            .toBe(k19Referens(ny, gammal, golv));
        }
      }
    }
  });
});
