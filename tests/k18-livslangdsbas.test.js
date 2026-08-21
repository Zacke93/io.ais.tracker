'use strict';

jest.mock('homey');

/**
 * K18 — LIVSLÄNGDSBASEN FÅR FÖLJA EN SÄNKT NÄRHETSKLASS
 * (fältprov 10, dygnet 2026-08-19; skeptikerprövat + dirigentverifierat
 * 2026-08-20)
 *
 * FYNDET: `scheduleCleanup` returnerade i anti-förkortningsvakten INNAN
 * `_cleanupTimeoutMs.set`. Basnivån kunde därför bara skrivas av anrop som
 * ville FÖRLÄNGA — en nedgraderad närhetsklass nådde aldrig fram. Eftersom
 * `noteVesselSeen` laddar om max(kvarvarande, BAS) blev det en sluten
 * uppåtratchet: den högsta nivå ett fartyg någonsin haft blev dess
 * permanenta livslängd.
 *
 * FÄLTETS MÄTNING (DAPHNE, mmsi 219022098, huvudloggen app-20260819-081250):
 *   16:29:29  ⏱️ PROXIMITY_TIMEOUT distance=837m … timeout=2.0min
 *   16:30:36  ⏱️ PROXIMITY_TIMEOUT distance=872m, speed=0kn … timeout=10.0min
 *   16:30:36  🛡️ TIMER_PROTECTION  "existing expires in 920s, new would be 600s"
 *   16:45:15  🛡️ TIMER_PROTECTION  "existing expires in 1733s, new would be 600s"
 *   …          22 vägran / 0 accept, 48 livstecken som alla loggade "bas 1800s"
 *   17:38:02  💓 VESSEL_SEEN  (sista livstecknet)
 *   18:08:02  🗑️ STALE_AIS "no AIS message received for 36 minutes"
 *             ⇒ döden inföll exakt 1800 s + 1 ms efter sista livstecknet.
 * Sista RIKTIGA AIS-meddelandet kom 17:32:25 ⇒ 35,6 min efterliv med
 * targetBridge=none och 868 m till närmaste bro (närhetsklass 600 s).
 *
 * FIXEN (VesselDataService.js, anti-förkortningsvakten): basnivån skrivs
 * FÖRE returen för icke-oneShot-anrop. Vakten skyddar fortfarande den
 * AKTUELLA utgången — den tid som redan beviljats — men basen följer den
 * SENASTE klassningen i båda riktningar.
 *
 * TVÅ STORHETER, TVÅ ÄGARE (det svitens tester mäter):
 *   • `_cleanupExpiryTimes` = redan beviljad tid ⇒ kan bara förlängas.
 *   • `_cleanupTimeoutMs`   = fartygets senaste klassning ⇒ följer anroparen.
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { TIMEOUT_SETTINGS, UI_CONSTANTS } = require('../lib/constants');

function makeLogger() {
  return {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
}

// Fältets egna nivåer, med härledning:
//   ACTIVE_JOURNEY_MIN 1800 s — DAPHNEs bas under transiten (aktiv resa).
//   MEDIUM_DISTANCE     600 s — klassningen efter avslutad resa: 868 m från
//                               närmaste bro, targetBridge=none, 0 kn.
const BAS_AKTIV_RESA = TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN; // 1 800 000 ms
const BAS_EFTER_RESA = TIMEOUT_SETTINGS.MEDIUM_DISTANCE; // 600 000 ms

// Fältets faktiska pollavstånd mellan de två anropen (16:29:29 → 16:30:36).
const POLL_MS = 67 * 1000;

const DAPHNE = '219022098';

function makeService() {
  const logger = makeLogger();
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  // Lifecycle-motorn stubbas till "ingen elimination" av samma skäl som i
  // paket-f4/paket-p9: elimination-grenen sätter 100 ms MED forceElimination
  // och kringgår hela vakten — den är en ANNAN väg än den K18 mäter. I fältet
  // returnerade predikatet också false (ingen JOURNEY_COMPLETED loggades för
  // DAPHNE någonstans i de 36 minuterna).
  svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
  svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
  svc.passageWindowManager.isWithinInternalGracePeriod = () => false;
  return svc;
}

function seedVessel(svc, mmsi = DAPHNE, extra = {}) {
  const now = Date.now();
  svc.vessels.set(mmsi, {
    mmsi,
    lat: 58.2790, // ~868 m från närmaste bro, som i fältet
    lon: 12.2790,
    sog: 0,
    cog: 0,
    status: 'en-route',
    targetBridge: null, // resan var slut — fältets targetBridge=none
    passedBridges: [],
    timestamp: now,
    lastPositionUpdate: now,
    ...extra,
  });
  return svc.vessels.get(mmsi);
}

// ===========================================================================
// (1) DAPHNE-FALLET: en sänkt närhetsklass MÅSTE bli ny basnivå
// ===========================================================================
describe('K18(1): DAPHNE — vägrat anrop sänker BASEN men inte TIMERN', () => {
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T16:29:29.000Z'));
    svc = makeService();
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('KÄRNAN: vakten vägrar korta timern — men basen blir 600 s, inte 1800 s', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA); // aktiv resa: 30 min
    const expiryEfterTransit = svc._cleanupExpiryTimes.get(DAPHNE);
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(BAS_AKTIV_RESA);

    // Resan är slut; nästa poll klassar om till 600 s (868 m, targetBridge=none).
    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA);

    // Vakten gjorde sitt jobb: den REDAN BEVILJADE utgången rörs inte.
    expect(svc._cleanupExpiryTimes.get(DAPHNE)).toBe(expiryEfterTransit);
    // … men basnivån följer den nya klassningen. Före fixen: 1 800 000.
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(BAS_EFTER_RESA);
  });

  test('LOGGSPÅRET: TIMER_PROTECTION-raden är kvar och namnger den nya basen', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA);

    const rader = svc.logger.debug.mock.calls
      .map((c) => String(c[0]))
      .filter((r) => r.includes('[TIMER_PROTECTION]'));
    expect(rader).toHaveLength(1);
    // Prefixet är oförändrat — fältanalysens grep ('Refusing to shorten timer')
    // fortsätter träffa, annars vore historiken obrukbar.
    expect(rader[0]).toContain('Refusing to shorten timer');
    expect(rader[0]).toContain('new would be 600s');
    expect(rader[0]).toContain('basnivå → 600s');
  });

  test('LIVSTECKNET laddar om mot den NYA lägre basen när timern runnit ned', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA); // vägras — basen sänks

    // Spola fram tills mindre än 600 s återstår av den skyddade timern.
    // (1800 − 67 = 1733 s kvar; 1200 s senare återstår 533 s.)
    jest.advanceTimersByTime(1200 * 1000);
    const kvar = svc._cleanupExpiryTimes.get(DAPHNE) - Date.now();
    expect(kvar).toBeLessThan(BAS_EFTER_RESA);

    expect(svc.noteVesselSeen(DAPHNE)).toBe(true);
    // Före fixen: max(533 s, 1800 s) = 1800 s. Efter: max(533 s, 600 s) = 600 s.
    expect(svc._cleanupExpiryTimes.get(DAPHNE)).toBe(Date.now() + BAS_EFTER_RESA);
  });

  test('FÄLTETS UTFALL: efter sista livstecknet dör spöket på 600 s, inte 1800 s', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA); // omklassningen (vägras)

    // Fältets kadens: ett livstecken ungefär varje poll i ~35 min. 30 varv
    // à 67 s = 2010 s ⇒ den gamla 1800 s-timern har passerats flera gånger,
    // vilket är precis vad som höll DAPHNE vid liv.
    for (let i = 0; i < 30; i++) {
      jest.advanceTimersByTime(POLL_MS);
      svc.noteVesselSeen(DAPHNE);
    }
    expect(svc.vessels.has(DAPHNE)).toBe(true);

    // Källan tystnar. Efter basnivån (600 s) ska fartyget vara borta …
    jest.advanceTimersByTime(BAS_EFTER_RESA + 10);
    expect(svc.vessels.has(DAPHNE)).toBe(false);
  });

  test('MUTATIONSVAKT (mot fail-open): 599 s efter sista livstecknet lever hon ÄN', () => {
    // Skiljer "fixen sänkte basen till 600 s" från "något raderade fartyget
    // tidigare av annan orsak". Utan detta hade en trasig fix som raderar
    // direkt sett identisk ut i testet ovan.
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA);
    for (let i = 0; i < 30; i++) {
      jest.advanceTimersByTime(POLL_MS);
      svc.noteVesselSeen(DAPHNE);
    }
    jest.advanceTimersByTime(BAS_EFTER_RESA - 1000);
    expect(svc.vessels.has(DAPHNE)).toBe(true);
  });
});

// ===========================================================================
// (2) VAKTENS EGET UPPDRAG ÄR ORÖRT — timern kortas aldrig i förtid
// ===========================================================================
describe('K18(2): anti-förkortningsvakten skyddar fortfarande den AKTUELLA timern', () => {
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T16:29:29.000Z'));
    svc = makeService();
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('den långa timern överlever långt förbi den nya (lägre) basnivån', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA); // vägras

    // 600 s + marginal: om fixen hade skrivit om TIMERN vore fartyget borta här.
    jest.advanceTimersByTime(BAS_EFTER_RESA + 60 * 1000);
    expect(svc.vessels.has(DAPHNE)).toBe(true);

    // … och den lever ända fram till den ursprungliga 1800 s-utgången.
    jest.advanceTimersByTime(BAS_AKTIV_RESA - BAS_EFTER_RESA - 60 * 1000 + 10);
    expect(svc.vessels.has(DAPHNE)).toBe(false);
  });

  test('mitt-i-resan-fallet: en kort närhetsklass får inte radera en aktiv resa', () => {
    // Regressionsvakt för BUG 6:s ursprungliga fall — glesa AIS-sampel mitt i
    // en transit gav förr "hoppande" brotext. Timern måste bära resan även när
    // ett enskilt sampel klassar långt/kort.
    seedVessel(svc, DAPHNE, { targetBridge: 'Klaffbron', status: 'approaching' });
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    const expiry = svc._cleanupExpiryTimes.get(DAPHNE);
    svc.scheduleCleanup(DAPHNE, TIMEOUT_SETTINGS.FAR_DISTANCE); // 120 s — vägras
    expect(svc._cleanupExpiryTimes.get(DAPHNE)).toBe(expiry);
    jest.advanceTimersByTime(TIMEOUT_SETTINGS.FAR_DISTANCE + 10);
    expect(svc.vessels.has(DAPHNE)).toBe(true);
  });

  test('BASEN GÅR ÅT BÅDA HÅLL: en HÖGRE klassning skriver bas som förut', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, TIMEOUT_SETTINGS.FAR_DISTANCE);
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(TIMEOUT_SETTINGS.FAR_DISTANCE);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA); // förlängning: når svansen
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(BAS_AKTIV_RESA);
  });
});

// ===========================================================================
// (3) ENGÅNGSTILLÄGGEN FÅR FORTFARANDE ALDRIG BLI BAS
// ===========================================================================
describe('K18(3): oneShot och forceElimination skriver ALDRIG basnivån', () => {
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T16:29:29.000Z'));
    svc = makeService();
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('MUTATIONSVAKT: ett VÄGRAT oneShot-anrop skriver inte bas', () => {
    // Bevisar att den nya skrivningen bär `!oneShot`. Tas villkoret bort blir
    // livstecknets egen omladdning sin egen basnivå — F4:s ratchet tillbaka
    // genom en ny dörr.
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA, { oneShot: true }); // vägras
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(BAS_AKTIV_RESA);
  });

  test('protection-zonens 10 min-uppskov (oneShot) rör inte basen ens när det vägras', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    jest.advanceTimersByTime(POLL_MS);
    // Exakt anropet från removeVessel: uppskov, aldrig livslängdsnivå.
    svc.scheduleCleanup(DAPHNE, UI_CONSTANTS.CLEANUP_EXTENSION_MS, { oneShot: true });
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(BAS_AKTIV_RESA);
  });

  test('LIVSTECKNET kan inte sänka basen via sitt eget max()-anrop', () => {
    // Kedjan i sin helhet: noteVesselSeen ber om max(kvar, bas) med oneShot.
    // Det anropet kan landa strax UNDER den existerande utgången (millisekunder
    // hinner gå) och alltså träffa vakten — basen måste ändå stå kvar.
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA);
    jest.advanceTimersByTime(60 * 1000);
    svc.noteVesselSeen(DAPHNE);
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(BAS_EFTER_RESA);
  });

  test('100 ms-avrättningen (forceElimination) skriver ingen bas och når aldrig vakten', () => {
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    svc.vesselLifecycleManager.shouldEliminateVessel = () => true;
    svc.vesselLifecycleManager.getJourneyStatus = () => ({ reason: 'test' });

    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA); // blir 100 ms + forceElimination
    // Avrättningen får korta timern (F26) …
    expect(svc._cleanupExpiryTimes.get(DAPHNE)).toBe(Date.now() + 100);
    // … men 100 ms är ingen livslängd, och den vägrade grenen kördes inte:
    // basen är kvar på transitnivån.
    expect(svc._cleanupTimeoutMs.get(DAPHNE)).toBe(BAS_AKTIV_RESA);
    expect(svc.logger.debug.mock.calls.map((c) => String(c[0]))
      .some((r) => r.includes('[TIMER_PROTECTION]'))).toBe(false);
  });
});

// ===========================================================================
// (4) INGA SIDOEFFEKTER PÅ FARTYGSOBJEKTET (fältlist-fällans klass)
// ===========================================================================
describe('K18(4): fixen rör inga vessel-fält — bara timerkartorna', () => {
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T16:29:29.000Z'));
    svc = makeService();
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('det vägrade anropet lämnar fartygsobjektet byte-identiskt', () => {
    // K18 införde INGET nytt vessel-fält (skrivningen går till Map:en
    // `_cleanupTimeoutMs`), så fältlist-fällan i _createVesselObject är inte
    // aktiverad. Testet är beviset — inte en förhoppning.
    const vessel = seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    const före = JSON.stringify(vessel);
    const nycklarFöre = Object.keys(vessel).sort();

    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA);

    expect(Object.keys(vessel).sort()).toEqual(nycklarFöre);
    expect(JSON.stringify(vessel)).toBe(före);
  });

  test('_clearCleanupTimer städar den nyskrivna basen (ingen arvsläcka)', () => {
    // F4(3):s klass: en bas som överlever sin episod kan ärvas av ett
    // återvändande mmsi. Den nya skrivvägen får inte öppna det hålet.
    seedVessel(svc);
    svc.scheduleCleanup(DAPHNE, BAS_AKTIV_RESA);
    jest.advanceTimersByTime(POLL_MS);
    svc.scheduleCleanup(DAPHNE, BAS_EFTER_RESA);
    expect(svc._cleanupTimeoutMs.has(DAPHNE)).toBe(true);

    svc._clearCleanupTimer(DAPHNE);
    expect(svc._cleanupTimeoutMs.has(DAPHNE)).toBe(false);
    expect(svc._cleanupExpiryTimes.has(DAPHNE)).toBe(false);
  });
});
