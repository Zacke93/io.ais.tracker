'use strict';

jest.mock('homey');

/**
 * K18 DEL 2 — STALE_AIS-BACKSTOPPEN FÅR EN DRIVKRAFT
 * (fältprov 10, dygnet 2026-08-19; skeptikerprövat + dirigentverifierat
 * 2026-08-20)
 *
 * FYNDET: 30-minutersbackstoppen mot tyst transponder ligger som en GREN inne
 * i `removeVessel` och kan därför bara utvärderas när en cleanup-timer redan
 * brunnit ned. Fältdygnet skrev sina egna siffror:
 *   13:53:14  🗑️ [STALE_AIS] … vessel 211236030 … for 35 minutes
 *   18:08:02  🗑️ [STALE_AIS] … vessel 219022098 … for 36 minutes
 * — dvs. 5–6 min FÖRBI den tröskel raden själv citerar. Under efterlivet
 * drev spökena PROXIMITY_ANALYSIS/WAITING_CHECK på fryst data.
 *
 * DEL 1 (landad 2026-08-21, commit 51ceea5) stängde uppåtratchen som gjorde
 * fönstret så långt. DEL 2 är BACKSTOPPEN själv: ett svep på app.js
 * hälsotick (monitoring-loopen, 60 s) prövar samma villkor utan att invänta
 * timern ⇒ raderingen sker vid 30–31 min i stället för 34–36.
 *
 * KONTRAKTET: VILKA som tas bort är oförändrat — bara NÄR. Svepet flyttar
 * inte grenen, det gör den bara nåbar: `removeVessel(mmsi, 'timeout')` låter
 * grenen sätta `staleAisForcedRemoval` själv, så gravgaten och
 * protection-zonens bypass behåller exakt dagens semantik.
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const AISBridgeApp = require('../app');
const { UI_CONSTANTS, TIMEOUT_SETTINGS } = require('../lib/constants');

// Tröskeln som grenen i removeVessel prövar (30 min). Härledningen står i
// VesselDataService: äkta transpondertystnad, inte kadensglapp.
const STALE_MS = 30 * 60 * 1000;

const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Sant om NÅGON rad på kanalen innehåller taggen. */
const logHas = (svc, channel, tag) => svc.logger[channel].mock.calls
  .some((c) => c.some((arg) => String(arg).includes(tag)));

/**
 * KLIPP UT EN METODKROPP UR app.js-källan.
 *
 * Vakten längst ned i filen måste kunna säga "svepet ligger i DEN HÄR metoden
 * och ingen annan". Ett bart indexOf över hela filen träffar anropsraderna i
 * onInit och kan inte skilja metoder åt (granskningsfyndet 2026-08-21).
 *
 * Gränsen är nästa jsdoc-block på KLASSNIVÅ (`\n  /**`) — app.js har jsdoc
 * före varje metod. Klippet valideras: det måste börja på metodens
 * definitionsrad och sluta på dess avslutande klammer på klassnivå, annars
 * faller assertionen i stället för att vakten tyst klipper fel.
 * @param {string} src - app.js som text
 * @param {string} name - metodnamn utan parenteser
 * @returns {string} metodens källtext
 */
function methodSource(src, name) {
  const start = src.indexOf(`\n  ${name}() {`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  /**', start + 1);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  expect(body.trimEnd().endsWith('\n  }')).toBe(true);
  return body;
}

function makeService() {
  const logger = makeLogger();
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.vesselLifecycleManager.shouldEliminateVessel = () => false;
  svc.passageWindowManager.shouldShowRecentlyPassed = () => false;
  svc.passageWindowManager.isWithinInternalGracePeriod = () => false;
  return svc;
}

/**
 * @param {Object} svc
 * @param {string} mmsi
 * @param {number} silentMs - hur länge fartyget varit tyst
 * @param {Object} extra
 */
function seedVessel(svc, mmsi, silentMs, extra = {}) {
  const heardAt = Date.now() - silentMs;
  svc.vessels.set(mmsi, {
    mmsi,
    // DAPHNEs position i fältet: 868 m från närmaste bro ⇒ UTANFÖR
    // PROTECTION_ZONE_RADIUS, så protection-zonen är inte det som avgör.
    lat: 58.2790,
    lon: 12.2790,
    sog: 0,
    cog: 0,
    status: 'en-route',
    targetBridge: null,
    passedBridges: [],
    timestamp: heardAt,
    lastPositionUpdate: heardAt,
    ...extra,
  });
  return svc.vessels.get(mmsi);
}

describe('K18(2): sweepStaleVessels — backstoppen prövas utan att timern brunnit ned', () => {
  let svc;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T18:08:02.000Z'));
    svc = makeService();
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  test('FÄLTETS UTFALL: spöket tas bort vid 30 min även om timern är mycket längre', () => {
    seedVessel(svc, '219022098', STALE_MS + 1000);
    // Fältets läge: en 30-minuterstimer laddades nyss om av ett livstecken,
    // så cleanup-vägen hade fyrat först 30 min FRAM i tiden.
    svc.scheduleCleanup('219022098', TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    expect(svc.vessels.has('219022098')).toBe(true);

    expect(svc.sweepStaleVessels()).toBe(1);
    expect(svc.vessels.has('219022098')).toBe(false);
    // Grenen i removeVessel är den som skrev raden — svepet flyttade den inte.
    expect(logHas(svc, 'log', '[STALE_AIS]')).toBe(true);
    expect(logHas(svc, 'debug', '[STALE_AIS_SWEEP]')).toBe(true);
  });

  test('MUTATIONSVAKT: 1 ms UNDER tröskeln rörs ingenting (fönstret får inte krympa)', () => {
    seedVessel(svc, '211236030', STALE_MS - 1);
    expect(svc.sweepStaleVessels()).toBe(0);
    expect(svc.vessels.has('211236030')).toBe(true);
  });

  test('FÄRSKA OCH RÖRLIGA fartyg är orörda', () => {
    seedVessel(svc, '265636940', 30 * 1000); // hördes nyss
    seedVessel(svc, '304028000', 10 * 60 * 1000, { sog: 6.3, status: 'under-bridge' });
    expect(svc.sweepStaleVessels()).toBe(0);
    expect(svc.vessels.size).toBe(2);
  });

  test('RC1-SEMANTIKEN: max(timestamp, lastPositionUpdate) — en stillaliggande som SÄNDER lever', () => {
    // lastPositionUpdate fryses by design för stillaliggande fartyg. Skulle
    // svepet läsa den ensam hade aktivt sändande förtöjda båtar tvångsraderats
    // (19h-prodloggens 220276000 ×3) — samma fälla RC1 stängde 2026-06-11.
    const nu = Date.now();
    seedVessel(svc, '265552060', 0, {
      timestamp: nu - 60 * 1000, // meddelande för en minut sedan
      lastPositionUpdate: nu - 4 * 60 * 60 * 1000, // men positionen är 4 h gammal
    });
    expect(svc.sweepStaleVessels()).toBe(0);
    expect(svc.vessels.has('265552060')).toBe(true);
  });

  test('ett fartyg som redan är under radering hoppas över (RACE_PROTECTION)', () => {
    seedVessel(svc, '211495920', STALE_MS + 60 * 1000);
    svc._removalInProgress = new Set(['211495920']);
    expect(svc.sweepStaleVessels()).toBe(0);
    expect(svc.vessels.has('211495920')).toBe(true);
  });

  test('flera spöken i samma svep, och räknaren ljuger inte', () => {
    seedVessel(svc, '211236030', STALE_MS + 5 * 60 * 1000);
    seedVessel(svc, '219022098', STALE_MS + 6 * 60 * 1000);
    seedVessel(svc, '265636940', 60 * 1000); // färsk
    expect(svc.sweepStaleVessels()).toBe(2);
    expect([...svc.vessels.keys()]).toEqual(['265636940']);
  });

  test('EN KLOCKA: samma fartyg lever "nu" och är spöke en timme senare (systemklockan, ingen injektion)', () => {
    // GRANSKNINGEN 2026-08-21: metoden hade en `now`-parameter medan grenen i
    // removeVessel mäter om med sin EGEN Date.now(). Med en injicerad klocka
    // gick de två isär — svepet skrev sin diagnosrad och anropade
    // removeVessel, men grenen såg ett färskt fartyg och tog INTE
    // STALE_AIS-vägen. Det gamla testet asserterade bara räknaren (0/1) och
    // var därför falskt grönt: 1:an kom från den ORDINARIE timeout-vägen, med
    // annan gravgate-/completed-semantik. Parametern är borta; tiden styrs av
    // jest.setSystemTime, som fejkar samma klocka för BÅDA.
    seedVessel(svc, '231920000', 5 * 60 * 1000);
    expect(svc.sweepStaleVessels()).toBe(0);
    expect(svc.vessels.has('231920000')).toBe(true);

    jest.setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    expect(svc.sweepStaleVessels()).toBe(1);
    expect(svc.vessels.has('231920000')).toBe(false);
    // KRAVET, inte räknaren: det MÅSTE vara STALE_AIS-vägen
    // (staleAisForcedRemoval) som raderade — annars bär gravläggningen fel
    // tystnadsklass och F3-gravgaten kan inte skilja 30+ min äkta
    // transpondertystnad från ett 120 s kadensglapp.
    expect(logHas(svc, 'log', '[STALE_AIS]')).toBe(true);
    expect(logHas(svc, 'debug', '[STALE_AIS_SWEEP]')).toBe(true);
    // Ingen injicerbar klocka finns kvar att lura grenen med.
    expect(svc.sweepStaleVessels.length).toBe(0);
  });

  test('SVEPET FÖRLÄNGER ALDRIG ETT LIV — inte ens i skyddszonen', () => {
    // GRANSKNINGENS REPRODUCERADE FELMOD: med den injicerbara klockan
    // returnerade svepet 0, loggade "tyst i 65 min" och grenen föll sedan i
    // PROTECTION_ZONE — som SKJUTER UPP raderingen med CLEANUP_EXTENSION_MS.
    // Svepet gav alltså spöket TIO MINUTER EXTRA, rakt emot sitt eget syfte.
    // Invarianten är starkare än "protection-zonen kringgås": ett svep får
    // bara TA BORT, aldrig bevilja ny tid åt någon.
    const inZone = { lat: 58.28275, lon: 12.28345 }; // ~150 m från Klaffbron
    seedVessel(svc, '265573130', STALE_MS + 35 * 60 * 1000, inZone);
    seedVessel(svc, '211236030', STALE_MS + 60 * 1000); // utanför zonen
    seedVessel(svc, '265636940', 60 * 1000, inZone); // FÄRSK, i zonen
    svc.scheduleCleanup('265636940', TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    const expiryBefore = new Map(svc._cleanupExpiryTimes);

    expect(svc.sweepStaleVessels()).toBe(2);
    expect([...svc.vessels.keys()]).toEqual(['265636940']);
    // Ingen uppskovsrad: STALE_AIS-grenen gick före, som avsett.
    expect(logHas(svc, 'log', '[PROTECTION_ZONE]')).toBe(false);
    // INVARIANTEN: ingen överlevare fick en SENARE utgång än före svepet, och
    // ingen raderad lämnade en timer efter sig.
    for (const [mmsi, before] of expiryBefore) {
      const after = svc._cleanupExpiryTimes.get(mmsi);
      if (after !== undefined) expect(after).toBeLessThanOrEqual(before);
    }
    for (const mmsi of ['265573130', '211236030']) {
      expect(svc._cleanupExpiryTimes.has(mmsi)).toBe(false);
      expect(svc.cleanupTimers.has(mmsi)).toBe(false);
    }
  });

  test('tom fartygskarta är en ren no-op', () => {
    expect(svc.sweepStaleVessels()).toBe(0);
  });

  test('PROTECTION-ZONEN kringgås — det är hela poängen med backstoppen', () => {
    // 150 m från Klaffbron ⇒ inne i PROTECTION_ZONE_RADIUS. En vanlig timeout
    // hade skjutits upp; STALE_AIS-grenen går före, precis som i dag.
    seedVessel(svc, '265573130', STALE_MS + 60 * 1000, {
      lat: 58.28275, lon: 12.28345,
    });
    expect(svc.sweepStaleVessels()).toBe(1);
    expect(svc.vessels.has('265573130')).toBe(false);
  });
});

describe('K18(2): monitoring-loopen är drivkraften', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedTestMode = global.__TEST_MODE__;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = false;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedTestMode;
  });

  function riggApp(sweep) {
    const app = Object.create(AISBridgeApp.prototype);
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app.vesselDataService = { getVesselCount: () => 2, sweepStaleVessels: sweep };
    app.systemCoordinator = { cleanup: jest.fn() };
    app.aisClient = { pruneFusionState: jest.fn() };
    app._pruneDedupCaches = jest.fn();
    app._pruneVesselNameCache = jest.fn();
    app._pruneAisRejectLogTimes = jest.fn();
    app._pruneLastKnownPositionsTtl = jest.fn();
    app._checkAISFeedHealth = jest.fn();
    app._logProcessMemoryStats = jest.fn();
    return app;
  }

  test('en tick anropar svepet EN gång', () => {
    const sweep = jest.fn(() => 0);
    const app = riggApp(sweep);
    app._setupMonitoring();
    jest.advanceTimersByTime(UI_CONSTANTS.MONITORING_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    clearInterval(app._monitoringInterval);
  });

  test('KADENSEN stänger fältets fönster: 60 s ⇒ backstoppen fyrar inom 31 min', () => {
    // Fältet skrev "35 minutes" och "36 minutes". Med loopens kadens kan en
    // stale-radering aldrig ligga mer än ett tickintervall efter tröskeln.
    expect(UI_CONSTANTS.MONITORING_INTERVAL_MS).toBeLessThanOrEqual(60 * 1000);
    expect((STALE_MS + UI_CONSTANTS.MONITORING_INTERVAL_MS) / 60000).toBeLessThanOrEqual(31);
  });

  test('ett KASTANDE svep äter inte resten av tickens städning', () => {
    const sweep = jest.fn(() => {
      throw new Error('boom');
    });
    const app = riggApp(sweep);
    app._setupMonitoring();
    jest.advanceTimersByTime(UI_CONSTANTS.MONITORING_INTERVAL_MS);
    expect(app._logProcessMemoryStats).toHaveBeenCalledTimes(1);
    expect(app.error).toHaveBeenCalled();
    clearInterval(app._monitoringInterval);
  });

  test('en tjänst UTAN svepmetod är en tyst no-op (uppgraderingssäkert)', () => {
    const app = riggApp(undefined);
    app.vesselDataService = { getVesselCount: () => 0 };
    app._setupMonitoring();
    expect(() => jest.advanceTimersByTime(UI_CONSTANTS.MONITORING_INTERVAL_MS)).not.toThrow();
    expect(app._logProcessMemoryStats).toHaveBeenCalledTimes(1);
    clearInterval(app._monitoringInterval);
  });

  test('FACITVAKTEN: svepet ligger I _setupMonitoring-KROPPEN och ingen annanstans', () => {
    // _initializeCoalescingSystem anropas ovillkorligt från onInit UTAN
    // TEST_MODE-grind, och replayens fakeklocka stegar i samma 30 s-chunkar.
    // En tvångsraderare där hade flyttat korpusutfall direkt.
    //
    // GRANSKNINGEN 2026-08-21: vakten prövade tidigare bara INDEX (indexOf
    // mot -1) och råkade dessutom träffa ANROPSraderna i onInit, inte
    // metodkropparna. Den hade passerat om svepet flyttades till vilken som
    // helst metod som råkar ligga tidigare i filen. Nu klipps kropparna ut och
    // prövas var för sig.
    const src = require('fs').readFileSync(require.resolve('../app.js'), 'utf8');
    const monitoring = methodSource(src, '_setupMonitoring');
    const coalescing = methodSource(src, '_initializeCoalescingSystem');

    // (1) Svepet ligger i monitoring-kroppen …
    expect(monitoring).toContain('sweepStaleVessels();');
    // (2) … och INTE i watchdogens (den kropp som DRIVS i replay).
    expect(coalescing).toContain('_watchdogTimer = setTimeout(');
    expect(coalescing).not.toContain('sweepStaleVessels');
    // (3) EN ENDA DRIVKRAFT: samtliga omnämnanden i app.js ligger inne i
    //     monitoring-kroppen. Flyttas svepet någon annanstans faller den här
    //     raden, oavsett var i filen den nya platsen ligger.
    const countIn = (s) => s.split('sweepStaleVessels(').length - 1; // räknar ANROP, inte omnämnanden i kommentarer
    expect(countIn(monitoring)).toBeGreaterThan(0);
    expect(countIn(src)).toBe(countIn(monitoring));
    // (4) Ordningen inne i kroppen: svepet före den avslutande minnesraden.
    expect(monitoring.indexOf('sweepStaleVessels();'))
      .toBeLessThan(monitoring.indexOf('this._logProcessMemoryStats();'));
    // (5) TEST_MODE-grinden är kvar — utan den drivs svepet i replay.
    expect(monitoring).toContain("process.env.NODE_ENV === 'test' || global.__TEST_MODE__");
  });
});
