'use strict';

/**
 * ÖPPNINGSMOTORN — FÄLTPROV 10 (2026-08-19), GULA PAKETET
 * =============================================================================
 * TVÅ kirurgiska fynd i BridgeOpeningService, båda rådataverifierade mot
 * huvudloggen app-20260819-081250.log innan en rad kod ändrades.
 *
 * ⛔ K20a ÄR ÅTERKALLAD (dirigentbeslut 2026-08-21) och testas därför INTE här.
 *    Ledarprojektionen (_leadDistanceM) valde rätt båt i fältfallet men FEL i
 *    2 av 2 observerbara korpusfall — 20260525 Stridsbergsbron#7 flyttade
 *    ledarskapet från MARIANNE (korsade 09:48:26,601) till JOSEPHINE (09:48:38,858)
 *    och eta-tokenen 8 → 14 min mot sant 7,5, och 20260804-both-21h Klaffbron#27
 *    flyttade det från BLADE (korsade 12:10:24,796) till ELFKUNGEN, som U-svängde
 *    vid Olidebron och ALDRIG nådde Klaffbron. Ledarvalet är återställt till
 *    HEAD:s rå `arm.distanceM`-reduce; en egen kontraktsvakt längst ned låser det.
 *
 * K14  KONVOJTÄCKNINGEN ANKRADES I LEDARENS PROGNOS, INTE I PASSAGEN.
 *      Klaffbron#6 avfyrade 15:47:09,414 med NAVENs prognos 15:57:32,649 ⇒
 *      DAPHNE (absorberad 15:52:11,993) var "täckt t.o.m. 16:07:32,649".
 *      NAVENs FAKTISKA passage bokfördes 15:56:43,021 — 49,6 s FÖRE prognosen
 *      — men täckningen räknades aldrig om, och DAPHNE släpptes först
 *      16:07:39,671 (OPENING_RECOVER, d=263 m). Fixen rebaserar täckningen på
 *      den verkliga passagen, ENKELRIKTAT (bara kortare, aldrig längre).
 *      OBS: riktningsblindheten i _belongsToEvent är FRYST (C8/U11) och rörs
 *      inte av det här paketet.
 *
 * K13b HÄNDELSENS RIKTNING SAKNADES HELT. Stridsbergsbron#2 09:12 täckte TVÅ
 *      MÖTANDE båtar (BALTIC JONGLEUR north + TONGA south) och kortet påstod
 *      'southbound' — ledarens riktning. Payloaden bär nu `eventDirection`
 *      VID SIDAN AV det oförändrade `direction`-fältet, som öppningsfacit
 *      nycklas på. VOKABULÄREN ÄR DENSAMMA SOM `direction`
 *      ('northbound'/'southbound'), plus 'mixed' för mötande medlemmar och
 *      null för ingen uppgift — två riktningsfält i samma objekt ska kunna
 *      jämföras med `===` (dirigentbeslut 2026-08-21).
 *
 * FÄLTLIST-FÄLLAN: paketet lägger INGA nya fält på fartygsobjektet — armarna
 * lever i servicens egen Map (filens huvuddoktrin). Det låses av ett eget test
 * längst ned.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const geometry = require('../lib/utils/geometry');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position `distanceM` meter från bron längs bäring `bearingDeg` (220 = söder om). */
function posAtDistance(bridge, distanceM, bearingDeg = 220) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Fartygsobjekt i samma form som VesselDataService._createVesselObject ger. */
function makeVessel(overrides = {}) {
  const bridge = overrides.bridge || KLAFF;
  const distanceM = overrides.distanceM ?? 1000;
  const bearing = overrides.bearing ?? 220;
  const pos = posAtDistance(bridge, distanceM, bearing);
  const now = Date.now();
  return {
    mmsi: overrides.mmsi || '265999001',
    name: overrides.name || 'TESTBÅT',
    lat: pos.lat,
    lon: pos.lon,
    sog: overrides.sog === undefined ? 5 : overrides.sog,
    cog: overrides.cog ?? 40,
    timestamp: overrides.timestamp ?? now,
    fixTs: overrides.fixTs ?? now,
    targetBridge: overrides.targetBridge === undefined ? bridge.name : overrides.targetBridge,
    _routeDirection: overrides._routeDirection === undefined ? 'north' : overrides._routeDirection,
    _finalTargetDirection: overrides._finalTargetDirection ?? null,
    _hasMovementProof: overrides._hasMovementProof === undefined ? true : overrides._hasMovementProof,
    _moored: overrides._moored === true,
    _stationarySince: overrides._stationarySince === undefined ? null : overrides._stationarySince,
    navStatus: overrides.navStatus === undefined ? null : overrides.navStatus,
    etaMinutes: overrides.etaMinutes ?? null,
    passedAt: overrides.passedAt || {},
    passedBridges: overrides.passedBridges || [],
  };
}

describe('öppningsmotorn — fältprov 10 (K14 / K13b)', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const startTicker = (instance) => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => instance.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  };
  const advance = (ms) => jest.advanceTimersByTime(ms);
  const warnFor = (bridgeName) => warnings.filter((w) => w.bridge === bridgeName);
  const armOf = (mmsi, bridgeName = 'Klaffbron') => svc._arms.get(`${mmsi}::${bridgeName}`);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push(payload),
    });
    startTicker(svc);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // =========================================================================
  // K14 — TÄCKNINGEN REBASERAS PÅ DEN VERKLIGA PASSAGEN
  // =========================================================================
  describe('K14 — konvojtäckningen ankras i FÖRSTA FAKTISKA PASSAGEN', () => {
    /**
     * DAPHNE-kedjan i miniatyr, samma form som fältet:
     *   T0          LEAD 900 m/6 kn ⇒ deadlinen har redan förfallit ⇒ avfyrar.
     *               Händelsens referensankomst = LEAD:s prognos T0+291,6 s.
     *   T0          FOLLOWER 1200 m/5 kn ⇒ absorberas, täckt t.o.m. T0+891,6 s
     *               (max(firedAt, referensankomst) + CONVOY_WINDOW_MS).
     *   T0+240 s    LEAD passerar PÅ RIKTIGT — 51,6 s FÖRE sin egen prognos,
     *               precis som NAVEN gjorde 49,6 s före sin.
     * Efter fixen: täckningen kortas till T0+840 s.
     */
    const stageConvoy = () => {
      svc.observeVessel(makeVessel({
        mmsi: 'LEAD', name: 'NAVEN', distanceM: 900, sog: 6,
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'FOLLOWER', name: 'DAPHNE', distanceM: 1200, sog: 5,
      }));
    };

    it('absorptionen sätter täckningen på ledarens PROGNOS (utgångsläget)', () => {
      stageConvoy();
      expect(warnFor('Klaffbron')).toHaveLength(1);
      const follower = armOf('FOLLOWER');
      expect(follower.absorbedAt).toBe(T0);
      expect(follower.warnedAt).toBe(T0);
      // PROGNOSEN äger värdet: ledarens expectedArrivalMs + konvojfönstret.
      // Ledaren ligger ~291,3 s bort (899 m i 6 kn), inte där hon FAKTISKT
      // kommer att passera — och det är hela felet K14 stänger.
      expect(follower.coverUntilMs)
        .toBe(armOf('LEAD').expectedArrivalMs + BRIDGE_OPENING.CONVOY_WINDOW_MS);
      expect(follower.coverUntilMs - T0).toBeGreaterThan(BRIDGE_OPENING.CONVOY_WINDOW_MS);
    });

    it('en verklig passage FÖRE prognosen kortar täckningen till passage + konvojfönstret', () => {
      stageConvoy();
      const before = armOf('FOLLOWER').coverUntilMs;
      const leadForecast = armOf('LEAD').expectedArrivalMs;

      advance(240000); // LEAD passerar ~51,3 s före sin egen prognos
      const passageAt = Date.now();
      svc.notePassage('LEAD', 'Klaffbron');

      const follower = armOf('FOLLOWER');
      // KÄRNAN: täckningen ligger nu på PASSAGEN, inte på prognosen.
      expect(follower.coverUntilMs).toBe(passageAt + BRIDGE_OPENING.CONVOY_WINDOW_MS);
      // Vinsten är exakt prognosfelet — och den ligger i DAPHNE:s storleksklass
      // (fältet: NAVEN passerade 49,6 s före sin prognos).
      expect(before - follower.coverUntilMs).toBe(leadForecast - passageAt);
      expect(before - follower.coverUntilMs).toBeGreaterThan(45000);
      expect(before - follower.coverUntilMs).toBeLessThan(55000);
      // Och armen är fortfarande täckt — rebaseringen släpper aldrig i samma anrop.
      expect(follower.absorbedAt).not.toBeNull();
      expect(follower.coverUntilMs).toBeGreaterThan(passageAt);
    });

    it('den strandade armen frisläpps ETT HELT TICK tidigare och får sin egen varning', () => {
      stageConvoy();
      advance(240000);
      svc.notePassage('LEAD', 'Klaffbron');
      expect(warnFor('Klaffbron')).toHaveLength(1);

      // T0+840 s är den nya täckningsgränsen; ticket därefter ligger på T0+870 s.
      advance(600000); // → T0+840 s: fortfarande täckt (now <= coverUntilMs)
      expect(armOf('FOLLOWER').absorbedAt).not.toBeNull();
      expect(warnFor('Klaffbron')).toHaveLength(1);

      advance(30000); // → T0+870 s
      // Med den gamla prognosankringen (T0+891,6 s) hade den här varningen
      // kommit först på ticket T0+900 s — exakt DAPHNE:s förlorade tid.
      const klaff = warnFor('Klaffbron');
      expect(klaff).toHaveLength(2);
      expect(klaff[1].t).toBe(T0 + 870000);
      expect(klaff[1].mmsis).toEqual(['FOLLOWER']);
    });

    it('en passage EFTER prognosen förlänger ALDRIG täckningen (enkelriktad doktrin)', () => {
      stageConvoy();
      const before = armOf('FOLLOWER').coverUntilMs;

      advance(400000); // LEAD passerar 108 s EFTER sin prognos
      svc.notePassage('LEAD', 'Klaffbron');

      // Rebaseringen hade gett T0+1 000 s — den avvisas.
      expect(armOf('FOLLOWER').coverUntilMs).toBe(before);
      // …och frisläppningen sker på exakt samma tick som i baslinjen.
      advance(491576); // → T0+891,576 s, precis PÅ gränsen
      expect(armOf('FOLLOWER').absorbedAt).not.toBeNull();
      advance(30000);
      expect(armOf('FOLLOWER').absorbedAt).toBeNull();
    });

    it('rebaseringen loggar sitt eget spår (räknebar klass i fält)', () => {
      stageConvoy();
      advance(240000);
      svc.notePassage('LEAD', 'Klaffbron');
      const rebaseLines = logger.debug.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('[OPENING_COVER_REBASE]'));
      expect(rebaseLines).toHaveLength(1);
      expect(rebaseLines[0]).toContain('FOLLOWER');
      expect(rebaseLines[0]).toContain('täckningen kortas från');
      const seconds = Number(/\((\d+) s tidigare\)/.exec(rebaseLines[0])[1]);
      expect(seconds).toBeGreaterThanOrEqual(45);
      expect(seconds).toBeLessThanOrEqual(55);
    });
  });

  // =========================================================================
  // K13b — HÄNDELSENS RIKTNING VID SIDAN AV LEDARENS
  // =========================================================================
  describe('K13b — eventDirection beskriver medlemsmängden', () => {
    /** Mötande konvoj: en norrgående söder om bron, en sydgående norr om den. */
    const stageMixed = () => {
      svc.observeVessel(makeVessel({
        mmsi: 'NORR',
        name: 'BALTIC JONGLEUR',
        distanceM: 1000,
        sog: 5,
        bearing: 220,
        _routeDirection: 'north',
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'SYD',
        name: 'TONGA',
        distanceM: 1100,
        sog: 5,
        bearing: 40,
        _routeDirection: 'south',
      }));
    };

    it('mötande medlemmar ⇒ eventDirection = "mixed", direction = LEDARENS (oförändrad)', () => {
      stageMixed();
      advance(30000);
      const klaff = warnFor('Klaffbron');
      expect(klaff).toHaveLength(1);
      expect(klaff[0].vesselCount).toBe(2);
      expect(klaff[0].eventDirection).toBe('mixed');
      // FACITKONTRAKTET: direction är och förblir ledande båtens token.
      expect(klaff[0].leadVessel).toBe('BALTIC JONGLEUR');
      expect(klaff[0].direction).toBe('northbound');
    });

    it('enhetlig konvoj ⇒ eventDirection = riktningen (samma token som direction)', () => {
      svc.observeVessel(makeVessel({
        mmsi: 'A', distanceM: 1000, sog: 5, _routeDirection: 'north',
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'B', distanceM: 1100, sog: 5, _routeDirection: 'north',
      }));
      advance(30000);
      const klaff = warnFor('Klaffbron');
      expect(klaff).toHaveLength(1);
      expect(klaff[0].vesselCount).toBe(2);
      expect(klaff[0].eventDirection).toBe('northbound');
      expect(klaff[0].direction).toBe('northbound');
      // VOKABULÄRKONTRAKTET: fälten är jämförbara med === när händelsen är enig.
      expect(klaff[0].eventDirection).toBe(klaff[0].direction);
    });

    it('ingen medlem med låst riktning ⇒ eventDirection = null — null, inte "unknown"', () => {
      svc.observeVessel(makeVessel({
        mmsi: 'OKAND', distanceM: 900, sog: 6, _routeDirection: null,
      }));
      const klaff = warnFor('Klaffbron');
      expect(klaff).toHaveLength(1);
      // `direction` måste vara en STRÄNG (facitnyckel) och faller på 'unknown';
      // eventDirection har ingen facitnyckel och följer payloadens null-konvention.
      expect(klaff[0].eventDirection).toBeNull();
      expect(klaff[0].eventDirection).not.toBe('unknown');
      expect(klaff[0].direction).toBe('unknown');
    });

    it('en medlem utan riktning röstar varken för enighet eller oenighet', () => {
      svc.observeVessel(makeVessel({
        mmsi: 'A', distanceM: 1000, sog: 5, _routeDirection: 'north',
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'X', distanceM: 1100, sog: 5, _routeDirection: null,
      }));
      advance(30000);
      const klaff = warnFor('Klaffbron');
      expect(klaff).toHaveLength(1);
      expect(klaff[0].vesselCount).toBe(2);
      expect(klaff[0].eventDirection).toBe('northbound');
    });

    it('enig SYDGÅENDE konvoj ⇒ "southbound", inte armens interna "south"', () => {
      // Andra halvan av vokabulärkontraktet: metoden får aldrig läcka armens
      // interna kod ('north'/'south') ut i payloaden.
      svc.observeVessel(makeVessel({
        mmsi: 'S1', distanceM: 1000, sog: 5, bearing: 40, _routeDirection: 'south',
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'S2', distanceM: 1100, sog: 5, bearing: 40, _routeDirection: 'south',
      }));
      advance(30000);
      const klaff = warnFor('Klaffbron');
      expect(klaff).toHaveLength(1);
      expect(klaff[0].vesselCount).toBe(2);
      expect(klaff[0].eventDirection).toBe('southbound');
      expect(klaff[0].eventDirection).toBe(klaff[0].direction);
    });

    it('blandriktningen loggas så att klassen blir räknebar i fält', () => {
      stageMixed();
      advance(30000);
      const mixedLines = logger.debug.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('[OPENING_MIXED_DIR]'));
      expect(mixedLines).toHaveLength(1);
      expect(mixedLines[0]).toContain('MÖTANDE');
    });
  });

  // =========================================================================
  // FÄLTLIST-FÄLLAN + KONTRAKTSVAKTER
  // =========================================================================
  describe('kontraktsvakter', () => {
    it('paketet lägger INGA nya fält på fartygsobjektet (fältlist-fällan)', () => {
      const vessel = makeVessel({ mmsi: 'RENT', distanceM: 900, sog: 6 });
      const before = Object.keys(vessel).sort();
      svc.observeVessel(vessel);
      svc.notePassage('RENT', 'Klaffbron');
      svc.tick();
      expect(Object.keys(vessel).sort()).toEqual(before);
    });

    it('payloadens befintliga fält är orörda — eventDirection är rent additivt', () => {
      svc.observeVessel(makeVessel({
        mmsi: 'SOLO', name: 'SOLO', distanceM: 900, sog: 6,
      }));
      const w = warnFor('Klaffbron')[0];
      for (const key of ['t', 'eventId', 'bridge', 'direction', 'etaMinutes', 'vesselCount',
        'leadVessel', 'leadMmsi', 'firedBy', 'mmsis', 'distanceM', 'dueMs',
        'originalDueMs', 'fixAgeMs']) {
        expect(Object.prototype.hasOwnProperty.call(w, key)).toBe(true);
      }
      expect(w.direction).toBe('northbound');
      expect(w.eventDirection).toBe('northbound');
      expect(w.vesselCount).toBe(1);
    });

    it('ledarvalet är HEAD:s råa armavstånd — ingen projektion (K20a återkallad)', () => {
      // REGRESSIONSVAKT mot att ledarprojektionen smyger tillbaka. Scenen är
      // fältets pollrace: TONGA bär ett 60 s gammalt fix på 1308 m, BALTIC
      // JONGLEUR ett färskt på 1277 m. K20a hade valt TONGA (normerat 1153 m);
      // HEAD väljer BALTIC JONGLEUR på rått avstånd, och det är det utfall
      // korpusfacit vilar på.
      expect(svc._leadDistanceM).toBeUndefined();
      svc.observeVessel(makeVessel({
        mmsi: 'TONGA', name: 'TONGA', distanceM: 2400, sog: 4.6,
      }));
      svc.observeVessel(makeVessel({
        mmsi: 'BJ', name: 'BALTIC JONGLEUR', distanceM: 2450, sog: 3.5,
      }));
      advance(60000);
      svc.observeVessel(makeVessel({
        mmsi: 'TONGA', name: 'TONGA', distanceM: 1308, sog: 4.6, fixTs: T0 + 50000,
      }));
      advance(50000);
      svc.observeVessel(makeVessel({
        mmsi: 'BJ', name: 'BALTIC JONGLEUR', distanceM: 1277, sog: 3.5,
      }));
      advance(40000);
      const klaff = warnFor('Klaffbron');
      expect(klaff).toHaveLength(1);
      expect(klaff[0].vesselCount).toBe(2);
      expect(klaff[0].leadVessel).toBe('BALTIC JONGLEUR');
      expect(klaff[0].leadMmsi).toBe('BJ');
      // Kortet bär ledarens EGET mätvärde (avrundat) — det närmaste RÅA
      // armavståndet, aldrig ett normerat/projicerat.
      expect(klaff[0].distanceM).toBe(Math.round(armOf('BJ').distanceM));
      expect(klaff[0].distanceM).toBe(1276);
      expect(Math.round(armOf('TONGA').distanceM)).toBe(1307);
    });

    it('geometrin i testet speglar fältet (rådataförankring)', () => {
      // Skalade tal, men samma broavstånd som fältet räknade på.
      const p = posAtDistance(KLAFF, 1308, 220);
      expect(Math.round(geometry.calculateDistance(p.lat, p.lon, KLAFF.lat, KLAFF.lon)))
        .toBe(1307);
    });
  });
});
