'use strict';

/**
 * U49 (dirigentens beslut, rättningsomgång 4): EN BÅT I RÖRELSE VID BROLINJEN
 * HÅLLS KVAR ÄVEN NÄR APPENS PROGNOS LIGGER STRAX EFTER TÄCKNINGSSLUTET.
 * =============================================================================
 * Nattjaktens värld 8814: BRISEN 2 är absorberad i en annan båts varnade
 * öppning vid Stridsbergsbron. Hennes sista fix är 43 m före bron i 4,5 kn.
 * Appens ETA nära bron är 1,31 min (utliggarskyddet och utjämningen lyfter
 * 0,3 min), så den förväntade ankomsten ligger 3,4 s efter täckningsslutet,
 * fast avstånd genom fart ger ankomsten 57 s före det. Under-bro-hållet (1c)
 * krävde prognosen inom täckningen, hon släpptes som egen öppning och
 * varnades 58 s efter sin passage. Värld 18489 (NORDVIND): 24 m i 5,7 kn,
 * prognosen 0,5 s efter, varning 73 s efter passagen.
 *
 * RÄTTNINGEN: för en båt i rörelse (minst 2 kn, MOVING_SOG_KN) är ankomsten i
 * hållet den TIDIGARE av appens prognos och armens fysik (physicsArrivalMs).
 * Under 2 kn gäller prognosen som förut. Kravet att ankomsten ligger inom
 * täckningen står kvar, för det är det som gör att hållet bara varar till
 * nästa fix: ett fix efter täckningsslutet har alltid sin ankomst efter
 * slutet. Att ta bort
 * kravet helt (U49:s ordalydelse) mättes: då hålls en krypare eller en
 * väntande båt med brusfart vid brolinjen på varje nytt fix och får ingen
 * varning (motfallen nedan, och det befintliga testet "ett nytt fix efter
 * täckningsslutet som visar att hon fortfarande väntar släpper henne" i
 * k-konvoj-recover-bakkant-glapp.test.js).
 *
 * På 6fad291 och 7633653 är 8814- och 18489-klasserna (båda broarna) och
 * schemaläggartestet röda; motfallen är gröna där också. Med täckningskravet
 * borttaget (U49 ordagrant) är krypar- och brusmotfallen röda. I blocket om
 * samspelet med U45 (sist i filen) är på 7633653 de fall röda där hållet
 * ändrar utfallet (A1, A3, B1, B2, F1); A1b, A2 och C1 är gröna där också.
 *
 * MUTATIONSPROVEN (granskningen i omgång 5). Var och en fälls av ett eget test:
 * täckningskravet borttaget från 2 kn, eller när fysiken ligger före
 * prognosen ("hållet varar bara till nästa fix också i rörelse"); `> 2` i
 * stället för `>= 2` ("gränsen: exakt 2,0 kn"); bara fysiken i stället för det
 * tidigaste av ("det tidigaste av: 2,2 kn").
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const S = 1000;
const KN = 0.514444;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position `distanceM` meter från bron längs bäring `bearingDeg`. */
function posAtDistance(bridge, distanceM, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

// Båda broarna och båda riktningarna: anflygningssidan är söder om bron för en
// norrgående båt (bäring 220) och norr om för en sydgående (bäring 40).
const CASES = [
  { bridgeName: 'Stridsbergsbron', bridge: BRIDGES.stridsbergsbron, dir: 'south' },
  { bridgeName: 'Klaffbron', bridge: BRIDGES.klaffbron, dir: 'north' },
];

describe.each(CASES)('U49: under-bro-hållet mäter ankomsten med fysiken ($bridgeName, $dir)', ({ bridgeName, bridge, dir }) => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;
  const approach = dir === 'north' ? 220 : 40;
  const beyond = dir === 'north' ? 40 : 220;

  const boat = (mmsi, distanceM, sog, o = {}) => {
    const pos = posAtDistance(bridge, distanceM, o.beyond ? beyond : approach);
    const now = Date.now();
    return {
      mmsi,
      name: mmsi,
      lat: pos.lat,
      lon: pos.lon,
      sog,
      cog: o.cog ?? (dir === 'north' ? 40 : 220),
      timestamp: now,
      fixTs: now,
      lastPositionUpdate: now,
      targetBridge: bridgeName,
      _routeDirection: dir,
      _finalTargetDirection: null,
      _hasMovementProof: true,
      _moored: false,
      _stationarySince: null,
      navStatus: null,
      etaMinutes: o.etaMinutes ?? null,
      passedAt: {},
      passedBridges: [],
    };
  };

  const advanceTo = (t) => jest.advanceTimersByTime(t - Date.now());
  const armOf = (mmsi) => svc._arms.get(`${mmsi}::${bridgeName}`);
  const own = (mmsi) => warnings.filter((w) => w.leadMmsi === mmsi);
  const holdLines = () => logger.debug.mock.calls.map((c) => String(c[0]))
    .filter((l) => l.includes('[OPENING_RECOVER_HOLD]'));

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push({ ...payload, t: Date.now() }),
      targetBridges: [bridgeName],
    });
    tickTimer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /**
   * Konvoj UTAN bokförd passage (som i 8814 och 18489): LEAD 900 m i 6 kn
   * avfyrar direkt och hörs sedan inte mer; FOLLOWER 2400 m i 6,9 kn
   * absorberas. Täckningen räknas från referensankomsten. Returnerar slutet.
   */
  const stageConvoyWithoutPassage = () => {
    svc.observeVessel(boat('LEAD', 900, 6));
    svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
    expect(warnings).toHaveLength(1);
    expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
    const cover = armOf('FOLLOWER').coverUntilMs;
    expect(Number.isFinite(cover)).toBe(true);
    return cover;
  };

  /** Sista fixet `ageS` s före täckningsslutet, prognosen `excessS` s efter det. */
  const lastFix = (cover, ageS, distanceM, sog, excessS) => {
    const tf = Math.round(cover - ageS * S);
    advanceTo(tf);
    svc.observeVessel(boat('FOLLOWER', distanceM, sog, { etaMinutes: (cover + excessS * S - tf) / 60000 }));
    expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
    return tf;
  };

  it('8814-klassen: 43 m i 4,5 kn, prognosen 3,4 s efter täckningen — ingen varning efter passagen', () => {
    const cover = stageConvoyWithoutPassage();
    const tf = lastFix(cover, 75.5, 43, 4.5, 3.4);
    const arm = armOf('FOLLOWER');
    expect(arm.expectedArrivalMs).toBeGreaterThan(cover);
    expect(arm.physicsArrivalMs).toBeLessThan(cover);
    advanceTo(cover + 32 * S);
    expect(own('FOLLOWER')).toHaveLength(0);
    expect(holdLines().some((l) => l.includes('under bron'))).toBe(true);
    // Nästa fix (sanningen: korsning tf + 18,6 s) ligger 167 m bortom bron.
    advanceTo(cover + 33 * S);
    svc.observeVessel(boat('FOLLOWER', 167, 3.3, { beyond: true }));
    expect(armOf('FOLLOWER')).toBeUndefined();
    advanceTo(cover + 1800 * S);
    expect(own('FOLLOWER')).toHaveLength(0);
    expect(tf + (43 / (4.5 * KN)) * S).toBeLessThan(cover);
  });

  it('18489-klassen: 24 m i 5,7 kn, prognosen 0,5 s efter, tyst därefter — ingen varning', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 81, 24, 5.7, 0.5);
    advanceTo(cover + 1800 * S);
    expect(own('FOLLOWER')).toHaveLength(0);
    expect(holdLines().some((l) => l.includes('under bron'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // MOTFALL: där dagens beteende ska stå kvar
  // ---------------------------------------------------------------------------
  it('motfall krypare: 45 m i 0,6 kn, fixet 5 s före slutet, fysiken efter — egen varning före korsningen', () => {
    const cover = stageConvoyWithoutPassage();
    const tf = lastFix(cover, 5, 45, 0.6, 30);
    const crossing = tf + (45 / (0.6 * KN)) * S;
    expect(armOf('FOLLOWER').physicsArrivalMs).toBeGreaterThan(cover);
    advanceTo(cover + 31 * S);
    expect(own('FOLLOWER')).toHaveLength(1);
    expect(own('FOLLOWER')[0].t).toBeLessThan(crossing);
  });

  it('motfall krypare under ETA-golvet: prognosen inom, fysiken efter — hålls som förut', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 60, 45, 0.7, -10); // appens prognos (golvet 2,5 kn) före fysiken
    expect(armOf('FOLLOWER').physicsArrivalMs).toBeGreaterThan(cover);
    advanceTo(cover + 31 * S);
    expect(own('FOLLOWER')).toHaveLength(0);
    expect(holdLines().some((l) => l.includes('under bron'))).toBe(true);
  });

  it('motfall: hållet varar bara till nästa fix — hon ligger kvar och väntar ⇒ egen varning på det fixet', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 75.5, 43, 4.5, 3.4);
    advanceTo(cover + 60 * S);
    // Basen varnade redan vid täckningsslutet; rättningen varnar på fixet.
    // Båda ger EN egen varning, senast på fixet som visar att hon väntar.
    svc.observeVessel(boat('FOLLOWER', 40, 0.1));
    expect(own('FOLLOWER')).toHaveLength(1);
    expect(own('FOLLOWER')[0].t).toBeLessThanOrEqual(cover + 60 * S);
    advanceTo(cover + 1800 * S);
    expect(own('FOLLOWER')).toHaveLength(1);
  });

  it('motfall: hållet varar bara till nästa fix också i rörelse — 40 m i 2,5 kn efter slutet släpper henne på det fixet', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 75.5, 43, 4.5, 3.4);
    advanceTo(cover + 40 * S);
    expect(own('FOLLOWER')).toHaveLength(0);
    // Hon manövrerar vid bron i 2,5 kn: fysiken ur ett fix efter slutet
    // ligger efter slutet, så täckningskravet släpper henne nu.
    svc.observeVessel(boat('FOLLOWER', 40, 2.5, { etaMinutes: 1.2 }));
    expect(own('FOLLOWER')).toHaveLength(1);
    expect(own('FOLLOWER')[0].t).toBeLessThanOrEqual(cover + 40 * S);
  });

  it('motfall: väntande båt med brusfart vid brolinjen släpps på första fixet efter slutet', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 75.5, 43, 4.5, 3.4);
    advanceTo(cover + 67 * S);
    // GPS-brus: 0,9 kn och en kurs som pekar snett; hon har inte rört sig.
    // Utan täckningskravet hade hållet förnyats här (U49 ordagrant).
    svc.observeVessel(boat('FOLLOWER', 41, 0.9, { cog: dir === 'north' ? 300 : 120 }));
    expect(own('FOLLOWER')).toHaveLength(1);
    expect(own('FOLLOWER')[0].t).toBeLessThanOrEqual(cover + 67 * S);
  });

  it('motfall: under 2 kn läses inte fysiken — 45 m i 1,5 kn, prognosen efter, fysiken inom ⇒ egen varning som förut', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 120, 45, 1.5, 20);
    expect(armOf('FOLLOWER').physicsArrivalMs).toBeLessThan(cover);
    advanceTo(cover + 31 * S);
    expect(own('FOLLOWER')).toHaveLength(1);
  });

  // GRÄNSEN VID EXAKT 2,0 KN (granskningen, anmärkning 2): fysiken läses från
  // och med MOVING_SOG_KN, samma >= som i _courseAway och bakkanten. 45 m i
  // 2,0 kn ger fysiken 44 s; fixet 60 s före slutet lägger den 16 s före
  // slutet, prognosen 10 s efter. Hon hålls; 1,99 kn varnas som förut.
  it('gränsen: exakt 2,0 kn läser fysiken och hålls', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 60, 45, 2.0, 10);
    expect(armOf('FOLLOWER').physicsArrivalMs).toBeLessThan(cover);
    expect(armOf('FOLLOWER').expectedArrivalMs).toBeGreaterThan(cover);
    advanceTo(cover + 31 * S);
    expect(own('FOLLOWER')).toHaveLength(0);
    expect(holdLines().some((l) => l.includes('under bron') && l.includes('fysiken'))).toBe(true);
  });

  it('gränsen, motfall: 1,99 kn med samma läge läser inte fysiken ⇒ egen varning vid täckningsslutet', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 60, 45, 1.99, 10);
    expect(armOf('FOLLOWER').physicsArrivalMs).toBeLessThan(cover);
    advanceTo(cover + 31 * S);
    expect(own('FOLLOWER')).toHaveLength(1);
  });

  // DET TIDIGASTE AV PROGNOSEN OCH FYSIKEN, ÅT ANDRA HÅLLET (granskningen,
  // anmärkning 3): i 2,2 kn kan appens prognos ligga FÖRE fysiken (ETA-kedjans
  // golv 2,5 kn). 45 m i 2,2 kn ger fysiken 40 s; fixet 20 s före slutet lägger
  // den 20 s efter slutet, prognosen 10 s före. Prognosen inom täckningen håller
  // henne, som före U49; en variant som bara läser fysiken hade släppt henne.
  it('det tidigaste av: 2,2 kn, prognosen inom och fysiken efter täckningen ⇒ hålls (prognosen avgör)', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 20, 45, 2.2, -10);
    expect(armOf('FOLLOWER').physicsArrivalMs).toBeGreaterThan(cover);
    expect(armOf('FOLLOWER').expectedArrivalMs).toBeLessThan(cover);
    advanceTo(cover + 31 * S);
    expect(own('FOLLOWER')).toHaveLength(0);
    expect(holdLines().some((l) => l.includes('under bron'))).toBe(true);
  });

  it('motfall: under 0,5 kn eller bortom 50 m hålls hon inte (som förut)', () => {
    const cover = stageConvoyWithoutPassage();
    lastFix(cover, 75.5, 55, 4.5, 3.4);
    advanceTo(cover + 31 * S);
    expect(own('FOLLOWER')).toHaveLength(1);
  });
});

describe('U49: hållet med schemaläggaren (appens läge)', () => {
  it('en hållen arm bokar ingen nolltidstimer', () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const logger = makeLogger();
    const warnings = [];
    const svc = new BridgeOpeningService({
      logger, onWarning: (p) => warnings.push(p), targetBridges: ['Stridsbergsbron'], scheduleDeadlines: true,
    });
    const bridge = BRIDGES.stridsbergsbron;
    const mk = (mmsi, d, sog, eta = null) => {
      const pos = posAtDistance(bridge, d, 40);
      const now = Date.now();
      return {
        mmsi,
        name: mmsi,
        lat: pos.lat,
        lon: pos.lon,
        sog,
        cog: 220,
        timestamp: now,
        fixTs: now,
        lastPositionUpdate: now,
        targetBridge: 'Stridsbergsbron',
        _routeDirection: 'south',
        _finalTargetDirection: null,
        _hasMovementProof: true,
        _moored: false,
        _stationarySince: null,
        navStatus: null,
        etaMinutes: eta,
        passedAt: {},
        passedBridges: [],
      };
    };
    try {
      svc.observeVessel(mk('LEAD', 900, 6));
      svc.observeVessel(mk('FOLLOWER', 2400, 6.9));
      const cover = svc._arms.get('FOLLOWER::Stridsbergsbron').coverUntilMs;
      const tf = Math.round(cover - 75.5 * S);
      jest.advanceTimersByTime(tf - Date.now());
      svc.observeVessel(mk('FOLLOWER', 43, 4.5, (cover + 3.4 * S - tf) / 60000));
      jest.advanceTimersByTime(cover + 1 - Date.now());
      const lines = logger.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[OPENING_RECOVER_HOLD]'));
      expect(lines).toHaveLength(1);
      expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
      expect(Number.isFinite(svc._scheduledDeadline)).toBe(false);
    } finally {
      svc.destroy();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

// Omgång 5: U45 fanns inte när rättningen byggdes. Båda broarna i BÅDA
// riktningarna.
const CASES_U45 = [
  { bridgeName: 'Stridsbergsbron', bridge: BRIDGES.stridsbergsbron, dir: 'south' },
  { bridgeName: 'Stridsbergsbron', bridge: BRIDGES.stridsbergsbron, dir: 'north' },
  { bridgeName: 'Klaffbron', bridge: BRIDGES.klaffbron, dir: 'north' },
  { bridgeName: 'Klaffbron', bridge: BRIDGES.klaffbron, dir: 'south' },
];

/**
 * SAMSPELET MED U45 OCH ANGREPPEN (rättningsomgång 5, granskningen av U49).
 * U45 (en annan båts passage förbrukar den varnade öppningen) rör samma
 * händelser: _noteForeignPassage, _foreignPassageVerdict,
 * _releaseForeignPassageMembers och foreignReleasedFrom. Hållet vid
 * täckningsslutet läser ingen av dem, och U45:s dom gäller bara före
 * täckningsslutet och utanför väntzonen. Fallen nedan låser det: en båt i
 * hållet medan en annan båt passerar (A1, A1b), en annan båts passage före
 * täckningsslutet (A2) och en U45-släppt båt som hamnar i hållet (A3). B1, B2
 * och F1 låser kostnaden och flera båtar, C1 att ett flaggat GPS-hopp vid
 * brolinjen aldrig når armen (observeVessel släpper det) och inte ger något håll.
 */
describe.each(CASES_U45)('U49 och U45: hållet bredvid en annan båts passage ($bridgeName, $dir)', ({ bridgeName, bridge, dir }) => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;
  const other = dir === 'north' ? 'south' : 'north';

  const boat = (mmsi, distanceM, sog, o = {}) => {
    const d = o.dir || dir;
    const appr = d === 'north' ? 220 : 40;
    const bey = d === 'north' ? 40 : 220;
    const pos = posAtDistance(bridge, distanceM, o.beyond ? bey : appr);
    const now = Date.now();
    return {
      mmsi,
      name: mmsi,
      lat: pos.lat,
      lon: pos.lon,
      sog,
      cog: o.cog ?? (d === 'north' ? 40 : 220),
      timestamp: now,
      fixTs: o.fixTs ?? now,
      lastPositionUpdate: now,
      targetBridge: bridgeName,
      _routeDirection: d,
      _finalTargetDirection: null,
      _hasMovementProof: true,
      _moored: false,
      _stationarySince: null,
      _gpsJumpDetected: o.jump || false,
      navStatus: null,
      etaMinutes: o.etaMinutes ?? null,
      passedAt: {},
      passedBridges: [],
    };
  };

  const advanceTo = (t) => jest.advanceTimersByTime(t - Date.now());
  const armOf = (mmsi) => svc._arms.get(`${mmsi}::${bridgeName}`);
  const lines = (tag) => logger.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(tag));

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push({ ...payload, t: Date.now() }),
      targetBridges: [bridgeName],
    });
    tickTimer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const stage = () => {
    svc.observeVessel(boat('LEAD', 900, 6));
    svc.observeVessel(boat('FOLLOWER', 2400, 6.9));
    expect(warnings).toHaveLength(1);
    expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
    return armOf('FOLLOWER').coverUntilMs;
  };
  const lastFix = (mmsi, cover, ageS, distanceM, sog, excessS, o = {}) => {
    const tf = Math.round(cover - ageS * S);
    advanceTo(tf);
    svc.observeVessel(boat(mmsi, distanceM, sog, { ...o, etaMinutes: (cover + excessS * S - tf) / 60000 }));
    return tf;
  };

  // A1: en annan båt (egen händelse, motsatt riktning) passerar medan
  // FOLLOWER hålls. Passagen noteras på LEADs händelse (U45), men hållet läser
  // den inte; FOLLOWER hörs nästa gång bortom bron och varnas aldrig.
  it('A1: hållen båt, en annan båt passerar under hållet, sedan bortom bron: ingen varning för henne', () => {
    const cover = stage();
    lastFix('FOLLOWER', cover, 75.5, 43, 4.5, 3.4);
    advanceTo(cover + 32 * S);
    expect(lines('[OPENING_RECOVER_HOLD]').length).toBe(1);
    // OTHER: mötande båt, beväpnas nu 600 m ut och passerar 140 s senare.
    svc.observeVessel(boat('OTHER', 600, 8, { dir: other }));
    advanceTo(cover + 60 * S);
    svc.observeVessel(boat('OTHER', 200, 8, { dir: other }));
    advanceTo(cover + 140 * S);
    svc.observeVessel(boat('OTHER', 80, 8, { dir: other, beyond: true }));
    expect(svc._arms.get(`OTHER::${bridgeName}`)).toBeUndefined();
    expect(lines('[OPENING_FOREIGN_PASSAGE]').length).toBeGreaterThanOrEqual(1);
    expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
    expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
    advanceTo(cover + 200 * S);
    svc.observeVessel(boat('FOLLOWER', 167, 3.3, { beyond: true }));
    expect(armOf('FOLLOWER')).toBeUndefined();
    advanceTo(cover + 1800 * S);
    expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
    expect(warnings.filter((w) => w.leadMmsi === 'OTHER')).toHaveLength(1);
  });

  // A1b: som A1, men nästa fix visar att hon väntar 40 m före bron. Hon släpps
  // ur LEADs händelse och absorberas enligt U2 i OTHERs passerade öppning
  // (ankomst inom 600 s efter dess passage), så hon varnas först när den
  // täckningen löper ut. På 7633653 är utfallet detsamma: där släpptes hon vid
  // täckningsslutet och absorberades i OTHERs ännu opasserade händelse.
  it('A1b: som A1 men nästa fix visar att hon väntar: U2 täcker henne, varning vid den täckningens slut', () => {
    const cover = stage();
    lastFix('FOLLOWER', cover, 75.5, 43, 4.5, 3.4);
    svc.observeVessel(boat('OTHER', 600, 8, { dir: other }));
    advanceTo(cover + 60 * S);
    svc.observeVessel(boat('OTHER', 200, 8, { dir: other }));
    advanceTo(cover + 140 * S);
    svc.observeVessel(boat('OTHER', 80, 8, { dir: other, beyond: true }));
    expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
    advanceTo(cover + 200 * S);
    svc.observeVessel(boat('FOLLOWER', 40, 0.1));
    // U2: hon släpps ur E1 och absorberas i OTHERs passerade öppning (ankomst
    // inom 600 s efter dess första passage). Ingen egen varning nu.
    expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
    expect(armOf('FOLLOWER').eventId).toBe(`${bridgeName}#2`);
    const cover2 = armOf('FOLLOWER').coverUntilMs;
    // Hon väntar kvar med fix var 60:e s: varnas vid den täckningens slut.
    for (let t = cover + 260 * S; t <= cover2 + 120 * S; t += 60 * S) {
      advanceTo(t);
      svc.observeVessel(boat('FOLLOWER', 40, 0));
    }
    const fw = warnings.filter((w) => w.leadMmsi === 'FOLLOWER');
    expect(fw).toHaveLength(1);
    expect(fw[0].t).toBeGreaterThanOrEqual(cover2);
    expect(fw[0].t - cover2).toBeLessThanOrEqual(61 * S);
    expect(fw[0].reopenedMmsis).toBeUndefined();
  });

  // A2: den andra båten (egen händelse sedan före E1) passerar FÖRE
  // täckningsslutet: U45 noterar passagen på E1, FOLLOWER inom 50 m hålls.
  it('A2: en annan båt passerar före täckningsslutet; FOLLOWER inom 50 m hålls vid slutet', () => {
    svc.observeVessel(boat('OTHER', 2450, 3, { dir: other }));
    expect(armOf('OTHER') || svc._arms.get(`OTHER::${bridgeName}`)).toBeDefined();
    const cover = stage();
    expect(svc._arms.get(`OTHER::${bridgeName}`).eventId).not.toBe(armOf('FOLLOWER').eventId);
    advanceTo(cover - 400 * S);
    svc.observeVessel(boat('OTHER', 600, 8, { dir: other }));
    advanceTo(cover - 200 * S);
    svc.observeVessel(boat('OTHER', 80, 8, { dir: other, beyond: true }));
    expect(lines('[OPENING_FOREIGN_PASSAGE]').length).toBe(1);
    lastFix('FOLLOWER', cover, 75.5, 43, 4.5, 3.4);
    expect(armOf('FOLLOWER').absorbedAt).toBe(T0);
    advanceTo(cover + 1800 * S);
    expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
    expect(lines('[OPENING_RECOVER_HOLD]').some((l) => l.includes('under bron'))).toBe(true);
  });

  // A3: en båt som U45 släppt ur sin varnade öppning absorberas i en annan
  // händelse och hamnar i hållet. foreignReleasedFrom står kvar under hållet
  // och nollas när hon släpps vid täckningsslutet (_releaseCoveredArm, U45
  // varv 3), så kortet bär inte reopenedMmsis och appen öppnar inte den gamla
  // dedupspärren för ett släpp som inte vilar på ett färskt fix.
  it('A3: U45-släppt båt absorberas i en ny händelse, hålls vid dess slut; släpps på nästa fix utan reopenedMmsis', () => {
    // E1: A varnas 900 m ut och saktar in långt ute.
    svc.observeVessel(boat('A', 900, 6, { etaMinutes: 2.5 }));
    expect(warnings).toHaveLength(1);
    advanceTo(T0 + 60 * S);
    svc.observeVessel(boat('A', 880, 2.5, { etaMinutes: 20 }));
    // H: egen händelse (ankomst > 600 s från E1:s referens), passerar.
    advanceTo(T0 + 600 * S);
    svc.observeVessel(boat('H', 1200, 6, { etaMinutes: 3.9 }));
    advanceTo(T0 + 700 * S);
    svc.observeVessel(boat('H', 300, 6, { etaMinutes: 1.0 }));
    advanceTo(T0 + 840 * S);
    svc.observeVessel(boat('H', 80, 6, { beyond: true }));
    expect(lines('[OPENING_FOREIGN_PASSAGE]').length).toBe(1);
    // C: ny båt som varnas direkt och tystnar (som VEGA).
    advanceTo(T0 + 1300 * S);
    svc.observeVessel(boat('C', 900, 6, { etaMinutes: 2.5 }));
    const cWarn = warnings.find((w) => w.leadMmsi === 'C');
    expect(cWarn).toBeDefined();
    // A hörs efter U45-fönstret: släpps och absorberas i C:s händelse.
    advanceTo(T0 + 1450 * S);
    svc.observeVessel(boat('A', 800, 2.5, { etaMinutes: 9.5 }));
    expect(lines('[OPENING_FOREIGN_RELEASE]').length).toBe(1);
    const a = armOf('A');
    expect(a.foreignReleasedFrom).not.toBeNull();
    expect(a.absorbedAt).toBe(T0 + 1450 * S);
    const cover = a.coverUntilMs;
    lastFix('A', cover, 75.5, 43, 4.5, 3.4);
    advanceTo(cover + 32 * S);
    expect(lines('[OPENING_RECOVER_HOLD]').some((l) => l.includes('A (A)') && l.includes('under bron'))).toBe(true);
    expect(armOf('A').foreignReleasedFrom).not.toBeNull();
    const before = warnings.filter((w) => w.leadMmsi === 'A').length;
    // Nästa fix: hon ligger kvar och väntar ⇒ släpp vid täckningsslutet, flaggan nollas.
    advanceTo(cover + 90 * S);
    svc.observeVessel(boat('A', 40, 0.1));
    const aw = warnings.filter((w) => w.leadMmsi === 'A');
    expect(aw).toHaveLength(before + 1);
    expect(aw[aw.length - 1].reopenedMmsis).toBeUndefined();
  });

  // B: KOSTNADEN SOM U49 GODTAR. 45 m i 2,5 kn, fysiken inom täckningen och
  // prognosen efter: hålls. Stannar hon och tystnar varnas hon aldrig (B1; på
  // 7633653 vid täckningsslutet); hörs hon igen varnas hon på det fixet (B2).
  // I rådatan (bankens 27 korpusfiler och k1–k3) finns 90 episoder där en båt
  // setts i minst 2 kn högst 50 m före bron (94 från 0,5 kn): alla korsade,
  // ingen tystnade, en stannade 79 s med fix emellan.
  it('B1: 45 m i 2,5 kn, fysiken inom, prognosen efter, hon stannar och tystnar: ingen varning (U49:s kostnad)', () => {
    const cover = stage();
    lastFix('FOLLOWER', cover, 50, 45, 2.5, 10);
    expect(armOf('FOLLOWER').physicsArrivalMs).toBeLessThan(cover);
    advanceTo(cover + 3600 * S);
    expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(0);
  });
  it('B2: som B1, nästa fix 180 s efter det förra stilla 40 m före bron: varning på det fixet', () => {
    const cover = stage();
    lastFix('FOLLOWER', cover, 50, 45, 2.5, 10);
    advanceTo(cover + 130 * S);
    svc.observeVessel(boat('FOLLOWER', 40, 0));
    const fw = warnings.filter((w) => w.leadMmsi === 'FOLLOWER');
    expect(fw).toHaveLength(1);
    expect(Math.abs(fw[0].t - (cover + 130 * S))).toBeLessThan(S);
  });

  // C: GPS-utliggare vid brolinjen, flaggad som hopp.
  it('C1: flaggat GPS-hopp till 30 m i 4 kn strax före slutet ger inget håll (släpps vid täckningsslutet som förut)', () => {
    const cover = stage();
    lastFix('FOLLOWER', cover, 200, 300, 4, 60);
    lastFix('FOLLOWER', cover, 60, 30, 4, 10, { jump: true });
    expect(armOf('FOLLOWER').distanceM).toBeGreaterThan(250);
    advanceTo(cover + 31 * S);
    expect(lines('[OPENING_RECOVER_HOLD]')).toHaveLength(0);
    expect(warnings.filter((w) => w.leadMmsi === 'FOLLOWER')).toHaveLength(1);
  });

  // F: två följare vid bron samtidigt; hållet gäller per arm.
  it('F1: två följare, en i fönstret (hålls) och en stilla 45 m (släpps): bara den stilla varnas', () => {
    svc.observeVessel(boat('LEAD', 900, 6));
    svc.observeVessel(boat('F1', 2400, 6.9));
    svc.observeVessel(boat('F2', 2300, 6.9));
    const cover = armOf('F1').coverUntilMs;
    expect(armOf('F2').coverUntilMs).toBe(cover);
    lastFix('F1', cover, 75.5, 43, 4.5, 3.4);
    lastFix('F2', cover, 70, 45, 0.2, 30);
    advanceTo(cover + 31 * S);
    expect(warnings.filter((w) => w.leadMmsi === 'F1')).toHaveLength(0);
    const f2 = warnings.filter((w) => w.leadMmsi === 'F2' || (w.memberMmsis || []).includes('F2'));
    expect(f2.length).toBeGreaterThanOrEqual(1);
  });
});
