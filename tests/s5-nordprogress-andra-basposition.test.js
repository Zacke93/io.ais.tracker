'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * S5 — ANDRA BASPOSITIONEN FÖR NORDPROGRESSEN (systerställesrundan 2026-08-23)
 * =============================================================================
 *
 * FYNDET: `_northProgressMps` svarar null utan oldVessel, stashen
 * `_lastNorthProgress` skrivs bara vid en mätning, graven bär den inte, och
 * app.js:s Kanalinfartsregel (K1) kräver dessutom att stashens ts är EXAKT
 * senaste meddelandets. Vid trigger-punkten är fartyget typiskt >600 m från
 * närmaste bro, så PROXIMITY_TIMEOUT blir 120 s mot klass B:s 180 s kadens —
 * VARJE fix blir en VESSEL_ENTERED efter en timeout-radering, och K1 föll till
 * token 'okänd' i exakt den klass regeln byggdes för (COG-dödbandet 46–134°).
 *
 * FÄLTBEVISET (rådata, ej konstruerat): NORDIC SOLA 258715000 i korpusen
 * 20260713-41h (corpora-data/ais-replay-20260713-221737.jsonl).
 *   08:09:20.634Z  lat 58.26570667  lon 12.264425  sog 0,7  cog 66,6
 *   08:12:51.439Z  lat 58.26652667  lon 12.267525  sog 3,2  cog 46,5  ← notisen
 * Δt 210,805 s, Δlat 91,3 m ⇒ 0,433 m/s = 1,73× ribban 0,25. Hon fortsatte
 * norrut till lat 58,3137 (Klaffbron + Stridsbergsbron) — 'northbound' är sant.
 * Förflyttningen mellan de två fixarna är 203 m, dvs. ÖVER gravens
 * MAX_REBIRTH_DIST_M (200 m): GRAVE_SKIP slog till, och det är just därför
 * seedningen måste vara OBEROENDE av gravgaten. Graven vaktar BETEENDEbevis;
 * en kinematisk nordkomponent blir inte sämre av att båten flyttat sig.
 *
 * ANDRA FÄLTFALLET (marginellt, 0,256 mot ribban 0,25): JUNO 265576720 i
 * 20260804-17h, 13:25:08.845Z → 13:28:19.388Z (Δt 190,543 s, Δlat 48,8 m).
 *
 * PIPELINEN SOM PRÖVAS ÄR DEN RIKTIGA: VesselDataService.updateVessel skriver
 * stashen, och app.js:s eget `_getNotificationDirection` läser den. Inget
 * predikat härmas.
 *
 * KLOCKDOMÄNEN: posten i app._lastKnownPositions bär ingen fixTs, så det
 * syntetiska basobjektet lämnar fixTs/fixFeed null och _northProgressMps
 * använder sin dokumenterade mottagnings-dt-fallback. Testet sätter därför
 * systemklockan (Date.now() är den domänen) i stället för att skicka fixTs.
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { TRIGGER_POINTS, VESSEL_GRAVE } = require('../lib/constants');
const { COG_BANDS } = require('../lib/utils/cogDirection');
const geometry = require('../lib/utils/geometry');

// ---- FÄLTETS RÅDATA ----
const NORDIC_SOLA = {
  mmsi: '258715000',
  name: 'NORDIC SOLA',
  bas: { ts: 1784102960634, lat: 58.26570666666667, lon: 12.264425 },
  notis: {
    ts: 1784103171439, lat: 58.266526666666664, lon: 12.267525000000001, sog: 3.2, cog: 46.5,
  },
  mps: 0.433,
};

const JUNO = {
  mmsi: '265576720',
  name: 'JUNO',
  bas: { ts: 1785849908845, lat: 58.26558166666667, lon: 12.26397 },
  notis: {
    ts: 1785850099388, lat: 58.266020000000005, lon: 12.266073333333333, sog: 1.9, cog: 72.6,
  },
  mps: 0.256,
};

const makeVds = () => {
  const logger = {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(),
  };
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  // Samma form som produktionens app-referens (VesselDataService.this.app).
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    _lastKnownPositions: new Map(),
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  return svc;
};

/**
 * AIS-meddelandet, samma fält som replayRunner matar in. Utan explicit fixTs
 * sätter _createVesselObject fixTs = Date.now(), precis som i produktion när
 * källan inte bär någon fixtid.
 */
const asMessage = (s, name, fixTs = null) => ({
  lat: s.lat,
  lon: s.lon,
  sog: s.sog,
  cog: s.cog,
  name,
  ...(fixTs === null ? {} : { fixTs, fixFeed: 'aisstream' }),
});

/**
 * Posten app.js:_onVesselRemoved skriver: {lat, lon, t = removaltid,
 * posT = positionens EGEN tid}. Vi speglar den formen exakt.
 */
const seedLastKnown = (svc, fall, { posT, t } = {}) => {
  svc.app._lastKnownPositions.set(fall.mmsi, {
    lat: fall.bas.lat,
    lon: fall.bas.lon,
    t: t ?? fall.bas.ts,
    posT: posT ?? fall.bas.ts,
  });
};

/** Trigger-punktens kandidat, exakt som _getFlowTriggerCandidates bygger den. */
const canalCandidate = () => ({
  name: TRIGGER_POINTS.kanalinfarten.name,
  id: 'kanalinfarten',
  distance: 196,
  source: 'trigger-point',
});

describe('S5 steg 1 — rådatans egna tal', () => {
  test('NORDIC SOLA: 0,433 m/s ligger över ribban, cog 46,5° i dödbandet, 203 m > gravens 200 m', () => {
    const f = NORDIC_SOLA;
    const dtS = (f.notis.ts - f.bas.ts) / 1000;
    const mps = ((f.notis.lat - f.bas.lat) * 111320) / dtS;
    expect(dtS).toBeCloseTo(210.805, 3);
    expect(mps).toBeCloseTo(f.mps, 3);
    expect(mps).toBeGreaterThanOrEqual(VesselDataService.NORTH_PROGRESS_MIN_MPS);
    // Dödbandet: _getDirectionString svarar 'unknown' här, det är hela hålet.
    expect(f.notis.cog).toBeGreaterThan(COG_BANDS.NORTH_MAX);
    expect(f.notis.cog).toBeLessThan(COG_BANDS.SOUTH_MIN);
    // GRAVGATENS oberoende: förflyttningen överstiger gravens återfödelseradie.
    const flyttM = geometry.calculateDistance(
      f.notis.lat, f.notis.lon, f.bas.lat, f.bas.lon,
    );
    expect(flyttM).toBeGreaterThan(VESSEL_GRAVE.MAX_REBIRTH_DIST_M);
    expect(Math.round(flyttM)).toBe(203);
  });

  test('JUNO: marginalfallet 0,256 m/s ligger strax över ribban', () => {
    const f = JUNO;
    const dtS = (f.notis.ts - f.bas.ts) / 1000;
    const mps = ((f.notis.lat - f.bas.lat) * 111320) / dtS;
    expect(dtS).toBeCloseTo(190.543, 3);
    expect(mps).toBeCloseTo(f.mps, 3);
    expect(mps).toBeGreaterThanOrEqual(VesselDataService.NORTH_PROGRESS_MIN_MPS);
    expect(f.notis.cog).toBeGreaterThan(COG_BANDS.NORTH_MAX);
    expect(f.notis.cog).toBeLessThan(COG_BANDS.SOUTH_MIN);
  });
});

describe('S5 steg 2 — RIKTIGA updateVessel mäter mot sist kända position', () => {
  let svc;
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    jest.useFakeTimers();
    svc = makeVds();
  });
  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
    delete global.__TEST_MODE__;
  });

  test('KÄRNAN: återfödelse utan oldVessel ger nordbeviset (förut: null)', () => {
    const f = NORDIC_SOLA;
    seedLastKnown(svc, f);
    jest.setSystemTime(f.notis.ts);

    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(vessel._lastNorthProgress).not.toBeNull();
    expect(vessel._lastNorthProgress.mps).toBeCloseTo(f.mps, 3);
    // FÄRSKHETSKONTRAKTET: ts är DET MEDDELANDE mätningen gjordes på — annars
    // faller app.js:s regel till 'okänd' även med ett giltigt tal i stashen.
    expect(vessel._lastNorthProgress.ts).toBe(
      Math.max(vessel.lastPositionUpdate || 0, vessel.timestamp || 0),
    );
  });

  test('JUNO-marginalen mäts också (0,256 m/s)', () => {
    const f = JUNO;
    seedLastKnown(svc, f);
    jest.setSystemTime(f.notis.ts);

    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(vessel._lastNorthProgress.mps).toBeCloseTo(f.mps, 3);
  });

  test('UTAN post i kartan står stashen kvar på null (ingen gissning)', () => {
    const f = NORDIC_SOLA;
    jest.setSystemTime(f.notis.ts);

    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(vessel._lastNorthProgress).toBeNull();
  });

  test('SPÄRR 1 — MAXÅLDERN: en post äldre än gränsen duger inte som bas', () => {
    const f = NORDIC_SOLA;
    const maxAge = VesselDataService.NORTH_PROGRESS_REBIRTH_MAX_AGE_MS;
    expect(maxAge).toBe(VESSEL_GRAVE.TTL_MS);
    jest.setSystemTime(f.notis.ts);

    // Exakt på gränsen: fortfarande giltig bas.
    seedLastKnown(svc, f, { posT: f.notis.ts - maxAge });
    const påGränsen = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));
    expect(påGränsen._lastNorthProgress).not.toBeNull();

    // En millisekund äldre: ingen bas, ingen mätning.
    svc.removeVessel(f.mmsi, 'test-reset');
    seedLastKnown(svc, f, { posT: f.notis.ts - maxAge - 1 });
    const förGammal = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));
    expect(förGammal._lastNorthProgress).toBeNull();
  });

  test('SPÄRR 2 — FARTSPÄRREN: en teleport blir aldrig nordbevis', () => {
    const f = NORDIC_SOLA;
    jest.setSystemTime(f.notis.ts);
    // Basen 5 km rakt söderut på samma 210,8 s ⇒ implicerad fart ~46 knop.
    svc.app._lastKnownPositions.set(f.mmsi, {
      lat: f.notis.lat - 5000 / 111320,
      lon: f.notis.lon,
      t: f.bas.ts,
      posT: f.bas.ts,
    });

    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(vessel._lastNorthProgress).toBeNull();
    const rader = svc.logger.debug.mock.calls.map((c) => String(c[0]));
    expect(rader.some((r) => r.includes('NORTH_PROGRESS_REBIRTH') && r.includes('teleport'))).toBe(true);
  });

  test('AVGRÄNSNINGEN: med oldVessel gäller dubblettkontraktet — basen används INTE', () => {
    const f = NORDIC_SOLA;
    seedLastKnown(svc, f);
    jest.setSystemTime(f.notis.ts);
    const första = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name, f.notis.ts));
    const stash = { ...första._lastNorthProgress };
    expect(stash.mps).toBeCloseTo(f.mps, 3);

    // BYTE-IDENTISK OMLEVERANS 60 s senare: samma fixTs ⇒ fixDtMs = 0 ⇒ ingen
    // ny mätning, dvs. "vet inte". Posten i kartan finns kvar (den raderas bara
    // av sin 6h-TTL), så en fallback UTAN !oldVessel-villkoret hade mätt om mot
    // basen och skrivit en NY, färsk stämpel på ett gammalt bevis — precis det
    // omleveransfall färskhetskravet i app.js finns för.
    jest.setSystemTime(f.notis.ts + 60000);
    const andra = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name, f.notis.ts));

    expect(andra._lastNorthProgress.mps).toBeCloseTo(stash.mps, 6);
    expect(andra._lastNorthProgress.ts).toBe(stash.ts);
  });

  test('KLOCKAN ÄR posT, inte removaltiden t', () => {
    const f = NORDIC_SOLA;
    jest.setSystemTime(f.notis.ts);
    // Removalen skedde i samma ögonblick som det nya meddelandet (t = nu), men
    // POSITIONEN är 210,8 s gammal. Läses t i stället för posT blir dt = 0 och
    // mätningen omöjlig — det är hela poängen med att posten bär två klockor.
    seedLastKnown(svc, f, { t: f.notis.ts, posT: f.bas.ts });

    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(vessel._lastNorthProgress.mps).toBeCloseTo(f.mps, 3);
  });

  test('SAKNAD posT (äldre persisterad post): ingen bas alls — fail-CLOSED', () => {
    const f = NORDIC_SOLA;
    jest.setSystemTime(f.notis.ts);
    // Removaltiden t ligger 60 s EFTER fixen. Användes den som klocka blev dt
    // KORTARE och nordprogressen ÖVERSKATTAD till 0,605 m/s (sanningen: 0,433)
    // — fail-open i exakt den riktning regeln kan flytta tokenen. Utan posT
    // avstår vi därför helt.
    svc.app._lastKnownPositions.set(f.mmsi, {
      lat: f.bas.lat,
      lon: f.bas.lon,
      t: f.bas.ts + 60000,
    });

    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(vessel._lastNorthProgress).toBeNull();
  });

  test('SÖDERUT kan aldrig bli nordbevis (basen norr om nuvarande position)', () => {
    const f = NORDIC_SOLA;
    jest.setSystemTime(f.notis.ts);
    svc.app._lastKnownPositions.set(f.mmsi, {
      lat: f.notis.lat + 200 / 111320,
      lon: f.notis.lon,
      t: f.bas.ts,
      posT: f.bas.ts,
    });

    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    // Mätningen görs (den är ärlig), men värdet är negativt och kan därför
    // aldrig passera K1:s ribba. Ingen väg till 'southbound' existerar.
    expect(vessel._lastNorthProgress.mps).toBeLessThan(0);
  });
});

describe('S5 steg 3 — konsekvensen i app.js:s RIKTIGA Kanalinfartsregel', () => {
  let svc;
  let app;
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    jest.useFakeTimers();
    svc = makeVds();
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
  });
  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
    delete global.__TEST_MODE__;
  });

  test('NORDIC SOLA: notis-tokenen blir northbound i stället för unknown', () => {
    const f = NORDIC_SOLA;
    seedLastKnown(svc, f);
    jest.setSystemTime(f.notis.ts);
    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(app._getDirectionString(vessel)).toBe('unknown'); // dödbandet, oförändrat
    expect(app._getNotificationDirection(vessel, canalCandidate())).toBe('northbound');
  });

  test('Utan bas i kartan står tokenen kvar på unknown (regeln gissar inte)', () => {
    const f = NORDIC_SOLA;
    jest.setSystemTime(f.notis.ts);
    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    expect(app._getNotificationDirection(vessel, canalCandidate())).toBe('unknown');
  });

  test('Regeln är fortsatt zon-lokal: samma bevis ger unknown för en annan källa', () => {
    const f = NORDIC_SOLA;
    seedLastKnown(svc, f);
    jest.setSystemTime(f.notis.ts);
    const vessel = svc.updateVessel(f.mmsi, asMessage(f.notis, f.name));

    const annanKälla = { ...canalCandidate(), source: 'current' };
    expect(app._getNotificationDirection(vessel, annanKälla)).toBe('unknown');
  });
});
