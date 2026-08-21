'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * K1 — KANALINFART-REGELN + SVENSKA RIKTNINGSTOKENS (fältprov 10, 2026-08-19)
 * ANVÄNDARBESLUT A3 + F5
 * =============================================================================
 *
 * FYNDET: farleden in mot trigger-punkten Kanalinfarten löper ENE. Det första
 * sampel som hamnar innanför 300 m-radien — det som utlöser boat_near — ligger
 * därför nästan alltid i COG-dödbandet 46–134°, som _getDirectionString
 * MEDVETET svarar 'unknown' på. Tre instanser samma dygn, alla vid
 * Kanalinfarten, alla på väg IN:
 *
 *   LADYBIRD        06:53:38.459Z  cog 74,2°  (vände om 3 min senare)
 *   BALTIC JONGLEUR 08:51:50.176Z  cog 60,4°  (fortsatte in i kanalen)
 *   NAVEN           15:36:22.548Z  cog 55,7°  (fortsatte in i kanalen)
 *
 * FIXEN: när kursen inte kan avgöra saken frågar vi GEOGRAFIN. Nordprogressen
 * (tidsnormaliserad nordkomponent i m/s, samma mått och samma ribba som
 * kajvobbelgrinden i VesselDataService) stashas på fartyget vid varje
 * positionsuppdatering, och Kanalinfartsregeln kräver ≥ 0,25 m/s för att
 * flytta tokenen unknown → northbound. ALDRIG southbound: skip-grinden
 * (app.js ~6907) RADERAR sydgående kandidater utan kanalhistorik, så en
 * felaktig sydgissning hade tystat notiser som i dag går fram.
 *
 * SIFFRORNA NEDAN ÄR RÅDATA ur tests-korpusens källa
 * ~/.ais-tracker-logs/ais-replay-20260819-081250.jsonl — lat/lon/sog/cog,
 * MOTTAGNINGSTID (aisTimestamp) och FIXTID (fixTs) kopierade rad för rad.
 *
 * ⚠️ KLOCKDOMÄNEN ÄR RÄTTAD 2026-08-21 (granskarfynd). Fixens första
 * härledning räknade nordprogressen på MOTTAGNINGSseparationen, men
 * produktionens _northProgressMps delar med FIXseparationen
 * (GPSJumpAnalyzer.fixDtMs) när den finns — det är hela V8-regeln. Alla tre
 * fältfallen kommer från feed 'aishub', så fixDtMs är fixTs-deltat rakt av:
 *
 *   fartyg           Δlat        Δfix    m/s (FIX)   Δmottag   m/s (mottag)
 *   BALTIC JONGLEUR  0,00029°    70,0 s   0,461       66,714 s  0,484
 *   NAVEN            0,00037°    68,0 s   0,606       65,858 s  0,625
 *   LADYBIRD         0,00003°    29,0 s   0,115       69,483 s  0,048
 *
 * LADYBIRD ÄR FACIT FÖR ATT REGELN INTE ÖVERTRIGGAR: hon nådde som närmast
 * 230 m, vände (cog 255,5°) och förtöjde 423 m VÄSTER om punkten. På den
 * KORREKTA klockan ligger hon på 46 % av ribban (0,115 / 0,25) — MARGINALEN
 * ÄR 2,2×, inte 5× som mottagningsklockan påstod. Det är den siffra en
 * framtida sänkning av NORTH_PROGRESS_MIN_MPS måste vägas mot.
 *
 * FÄRSKHETEN (granskarfynd 2026-08-21): stashen är paret
 * `_lastNorthProgress = { mps, ts }` där ts är fartygets lastPositionUpdate
 * för det meddelande mätningen gjordes på, och regeln kräver att ts matchar
 * fartygets AKTUELLA lastPositionUpdate. Utan kravet kunde ett nordbevis
 * frysa: en "vet inte"-mätning (dt ≤ 0) skriver aldrig över, så beviset hade
 * kunnat bäras godtyckligt länge efter att båten flyttat sig.
 *
 * F5: tokenen som användaren läser är SVENSK ('norrut'/'söderut'/'okänd').
 * Interna jämförelser behåller 'northbound'/'southbound'/'unknown'.
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { TRIGGER_POINTS } = require('../lib/constants');
const { toUserDirection } = require('../lib/utils/directionTokens');

// ---- FÄLTETS RÅDATA (20260819-081250) ----
// iso  = aisTimestamp (mottagningsklockan, domän M)
// fixTs = fixTs (fixklockan, domän F — den produktionen räknar fysik på)
const FIELD = {
  balticJongleur: {
    mmsi: '304028000',
    name: 'BALTIC JONGLEUR',
    prev: {
      iso: '2026-08-19T08:50:43.462Z',
      fixTs: 1787129437000,
      lat: 58.26590,
      lon: 12.26522,
      sog: 1.5,
      cog: 67.5,
    },
    cur: {
      iso: '2026-08-19T08:51:50.176Z',
      fixTs: 1787129507000,
      lat: 58.26619,
      lon: 12.26634,
      sog: 2.4,
      cog: 60.4,
    },
    northMps: 0.4612, // FIXklockan (70,0 s) — produktionens värde
    recvMps: 0.4839, // MOTTAGNINGSklockan (66,714 s) — överskattningen V8 stängde
  },
  naven: {
    mmsi: '231920000',
    name: 'NAVEN',
    prev: {
      iso: '2026-08-19T15:35:16.690Z',
      fixTs: 1787153711000,
      lat: 58.26597,
      lon: 12.26562,
      sog: 1.6,
      cog: 67.9,
    },
    cur: {
      iso: '2026-08-19T15:36:22.548Z',
      fixTs: 1787153779000,
      lat: 58.26634,
      lon: 12.26692,
      sog: 3.0,
      cog: 55.7,
    },
    // NÄSTA äkta rad i korpusen (15:37:28.305Z) — används för stilla-fallet.
    nextFix: { iso: '2026-08-19T15:37:28.305Z', fixTs: 1787153842000 },
    northMps: 0.6057,
    recvMps: 0.6254,
  },
  ladybird: {
    mmsi: '265636940',
    name: 'LADYBIRD',
    prev: {
      iso: '2026-08-19T06:52:28.976Z',
      fixTs: 1787122334000,
      lat: 58.26609,
      lon: 12.26577,
      sog: 1.0,
      cog: 92.9,
    },
    cur: {
      iso: '2026-08-19T06:53:38.459Z',
      fixTs: 1787122363000,
      lat: 58.26612,
      lon: 12.26605,
      sog: 1.1,
      cog: 74.2,
    },
    northMps: 0.1152,
    recvMps: 0.0481,
  },
};

/**
 * Fartygsliknande objekt med KORPUSENS EGNA klockor: fixTs ur rådata (domän F)
 * och mottagningstid ur aisTimestamp (domän M). De två skiljer sig i fält —
 * med fixTs = Date.parse(iso) hade hela sviten körts på en klockdomän
 * produktionen aldrig använder, och V8-regeln aldrig prövats på riktiga data.
 */
const asFix = (s) => ({
  lat: s.lat,
  lon: s.lon,
  sog: s.sog,
  cog: s.cog,
  fixFeed: 'aishub',
  fixTs: s.fixTs,
  timestamp: Date.parse(s.iso),
  lastPositionUpdate: Date.parse(s.iso),
});

/** AIS-meddelande i den form updateVessel tar emot. */
const asMessage = (s, name) => ({
  lat: s.lat,
  lon: s.lon,
  sog: s.sog,
  cog: s.cog,
  name,
  fixFeed: 'aishub',
  fixTs: s.fixTs,
  aisTimestamp: Date.parse(s.iso),
});

const makeVds = () => {
  const logger = {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(),
  };
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  return svc;
};

/** Trigger-punktens kandidat, exakt som _getFlowTriggerCandidates bygger den. */
const canalCandidate = (overrides = {}) => ({
  name: TRIGGER_POINTS.kanalinfarten.name,
  id: 'kanalinfarten',
  distance: 234,
  source: 'trigger-point',
  ...overrides,
});

describe('K1 steg 1 — nordprogressen mäts ur fältets rådata', () => {
  let svc;
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    svc = makeVds();
  });
  afterEach(() => {
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
  });

  test.each([
    ['BALTIC JONGLEUR', FIELD.balticJongleur],
    ['NAVEN', FIELD.naven],
    ['LADYBIRD', FIELD.ladybird],
  ])('%s: nordkomponenten återges på tre decimaler (FIXklockan)', (_label, f) => {
    const measured = svc._northProgressMps(asFix(f.cur), asFix(f.prev));
    expect(measured).toBeCloseTo(f.northMps, 3);
  });

  test('ribban skiljer de tre fallen åt (0,25 m/s ligger MELLAN dem)', () => {
    const limit = VesselDataService.NORTH_PROGRESS_MIN_MPS;
    expect(limit).toBe(0.25);
    expect(FIELD.balticJongleur.northMps).toBeGreaterThanOrEqual(limit);
    expect(FIELD.naven.northMps).toBeGreaterThanOrEqual(limit);
    expect(FIELD.ladybird.northMps).toBeLessThan(limit);
    // MARGINALEN mot den enda kända falskpositiv-kandidaten är 2,2× — INTE 5×
    // som den felräknade mottagningsklockan påstod. Talet är kalibrerings-
    // underlaget: sänks ribban under 0,115 m/s släpps LADYBIRD igenom.
    expect(limit / FIELD.ladybird.northMps).toBeCloseTo(2.17, 1);
  });

  test.each([
    ['BALTIC JONGLEUR', FIELD.balticJongleur],
    ['NAVEN', FIELD.naven],
    ['LADYBIRD', FIELD.ladybird],
  ])('%s: fixseparationen vinner över mottagningstiden (V8), på fältets EGNA klockor', (_label, f) => {
    // Med fixTs: produktionens värde.
    expect(svc._northProgressMps(asFix(f.cur), asFix(f.prev))).toBeCloseTo(f.northMps, 3);
    // Utan fixTs/fixFeed finns ingen fixseparation ⇒ mottagningstiden används,
    // och talet blir ett ANNAT. Det var precis V8:s fynd (TIM 21:50:22,
    // 0,259 mot 0,146 m/s): en pollande källa levererar batchar med äldre fix.
    const noFix = { ...asFix(f.cur), fixFeed: null, fixTs: null };
    const prevNoFix = { ...asFix(f.prev), fixFeed: null, fixTs: null };
    expect(svc._northProgressMps(noFix, prevNoFix)).toBeCloseTo(f.recvMps, 3);
    expect(f.recvMps).not.toBeCloseTo(f.northMps, 3);
  });

  test('LADYBIRD: klockvalet är avgörande för MARGINALEN, inte för utfallet', () => {
    // Båda klockorna svarar "under ribban" — regeln fyrar inte i något fall.
    // Men mottagningsklockan (69,483 s, en dubbel pollcykel) UNDERSKATTAR
    // nordfarten 2,4× och gjorde marginalen till 5× i den första härledningen.
    const f = FIELD.ladybird;
    expect(f.northMps).toBeLessThan(VesselDataService.NORTH_PROGRESS_MIN_MPS);
    expect(f.recvMps).toBeLessThan(VesselDataService.NORTH_PROGRESS_MIN_MPS);
    expect(f.northMps / f.recvMps).toBeGreaterThan(2);
  });

  test('"vet inte" är null, aldrig 0 (första kontakt, saknad lat, dt ≤ 0)', () => {
    const cur = asFix(FIELD.naven.cur);
    const prev = asFix(FIELD.naven.prev);
    expect(svc._northProgressMps(cur, null)).toBeNull();
    expect(svc._northProgressMps({ ...cur, lat: null }, prev)).toBeNull();
    expect(svc._northProgressMps(cur, { ...prev, fixTs: cur.fixTs, timestamp: cur.timestamp })).toBeNull();
  });
});

describe('K1 steg 2 — stashen på fartyget (fältlist-fällan + färskheten)', () => {
  let svc;
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    svc = makeVds();
  });
  afterEach(() => {
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
  });

  test('updateVessel bokför nordprogressen MED tidsstämpel vid varje positionsuppdatering', () => {
    const f = FIELD.balticJongleur;
    const first = svc.updateVessel(f.mmsi, asMessage(f.prev, f.name));
    // Första kontakten kan inte mäta någon separation — "vet inte", inte 0.
    expect(first._lastNorthProgress).toBeNull();

    const second = svc.updateVessel(f.mmsi, asMessage(f.cur, f.name));
    // Talet ska vara mätt HÄR, i den vanliga uppdateringsvägen — inte inne i
    // kajvobbelgrinden, som bara körs när en målbro prövas och bara när båda
    // fixarna ligger söder om punkten.
    expect(second._lastNorthProgress.mps).toBeCloseTo(f.northMps, 3);
    // FÄRSKHETSKONTRAKTET (2026-08-22): ts ÄR det mätta meddelandets stämpel
    // max(lastPositionUpdate, timestamp) — mottagningstiden ingår så att en
    // senare omleverans utan ny mätning gör beviset gammalt.
    expect(second._lastNorthProgress.ts).toBe(
      Math.max(second.lastPositionUpdate || 0, second.timestamp || 0),
    );
  });

  test('_lastNorthProgress överlever _createVesselObject (utan arv vore regeln död)', () => {
    const proof = { mps: 0.4612, ts: 1787129510176 };
    const rebuilt = svc._createVesselObject('304028000', {
      lat: 58.26619, lon: 12.26634, sog: 2.4, cog: 60.4, name: 'BALTIC JONGLEUR',
    }, { lat: 58.26590, lon: 12.26522, _lastNorthProgress: proof });
    expect(rebuilt._lastNorthProgress).toEqual(proof);
  });

  test('"vet inte" skriver INTE över ett giltigt mätvärde, men 0 m/s gör det', () => {
    const f = FIELD.naven;
    svc.updateVessel(f.mmsi, asMessage(f.prev, f.name));
    const moving = svc.updateVessel(f.mmsi, asMessage(f.cur, f.name));
    expect(moving._lastNorthProgress.mps).toBeCloseTo(f.northMps, 3);

    // DUBBLETT: samma fix igen ⇒ ingen separation ⇒ ingen ny mätning, och
    // stashen står KVAR med sin gamla stämpel. Ett duplicerat meddelande är
    // inget bevis på stillhet — därför får stashens ts INTE följa med
    // mottagningsklockan: app.js kräver ts === max(lastPositionUpdate, timestamp)
    // och faller till 'okänd' så fort mottagningstiden dragit ifrån (verifieras
    // på app-nivå i "FÄRSKHETEN"-testet nedan).
    const duplicate = svc.updateVessel(f.mmsi, asMessage(f.cur, f.name));
    expect(duplicate._lastNorthProgress.mps).toBeCloseTo(f.northMps, 3);
    expect(duplicate._lastNorthProgress.ts).toBe(moving._lastNorthProgress.ts);
    expect(duplicate.timestamp).toBeGreaterThanOrEqual(duplicate._lastNorthProgress.ts);

    // STILLASTÅENDE: NYTT fix (egen fixTs), samma position ⇒ färsk mätning ≈ 0
    // ⇒ regeln självläker (båten som stannar tappar sitt nordbevis).
    const stopped = svc.updateVessel(f.mmsi, asMessage({
      ...f.cur, iso: f.nextFix.iso, fixTs: f.nextFix.fixTs,
    }, f.name));
    expect(stopped._lastNorthProgress.mps).toBeCloseTo(0, 3);
  });
});

describe('K1 steg 3 — regeln i notis-tokenen (app.js)', () => {
  let app;
  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
  });

  /**
   * Fartyg vid notisögonblicket. FÄRSKHETEN: beviset bär SAMMA ts som
   * fartygets lastPositionUpdate — det är kontraktet regeln kräver.
   */
  const vesselAt = (f, overrides = {}) => {
    const ts = Date.parse(f.cur.iso);
    return {
      mmsi: f.mmsi,
      name: f.name,
      cog: f.cur.cog,
      sog: f.cur.sog,
      lastPositionUpdate: ts,
      _lastNorthProgress: { mps: f.northMps, ts },
      ...overrides,
    };
  };

  /** Godtyckligt fartyg med ett FÄRSKT nordbevis på angiven m/s. */
  const provenAt = (mps, extra = {}) => ({
    mmsi: '7',
    sog: 3,
    lastPositionUpdate: 1787129510176,
    _lastNorthProgress: { mps, ts: 1787129510176 },
    ...extra,
  });

  test('BALTIC JONGLEUR 08:51:50 (cog 60,4°, 0,461 m/s) ⇒ norrut', () => {
    const dir = app._getNotificationDirection(vesselAt(FIELD.balticJongleur), canalCandidate());
    expect(dir).toBe('northbound');
    expect(toUserDirection(dir)).toBe('norrut');
  });

  test('NAVEN 15:36:22 (cog 55,7°, 0,606 m/s) ⇒ norrut', () => {
    const dir = app._getNotificationDirection(vesselAt(FIELD.naven), canalCandidate());
    expect(dir).toBe('northbound');
  });

  test('LADYBIRD 06:53:38 (cog 74,2°, 0,115 m/s) ⇒ okänd KVARSTÅR (hon vände)', () => {
    const dir = app._getNotificationDirection(vesselAt(FIELD.ladybird), canalCandidate());
    expect(dir).toBe('unknown');
    expect(toUserDirection(dir)).toBe('okänd');
  });

  test('FÄRSKHETEN: ett FRYST bevis (ts ≠ lastPositionUpdate) duger inte', () => {
    const f = FIELD.balticJongleur;
    // Samma bevis, färskt ⇒ norrut.
    expect(app._getNotificationDirection(vesselAt(f), canalCandidate())).toBe('northbound');

    // Båten har flyttat sig (ny lastPositionUpdate) men mätningen kunde inte
    // göras om — t.ex. identisk fixTs från samma feed, där fixDtMs ger 0 och
    // _northProgressMps svarar null, och null skriver aldrig över. Det är
    // exakt den tysta-transponder-klass K18 finns för (fältets 35–36 min).
    const frozen = vesselAt(f, { lastPositionUpdate: Date.parse(f.cur.iso) + 35 * 60 * 1000 });
    expect(app._getNotificationDirection(frozen, canalCandidate())).toBe('unknown');

    // Och ett bevis UTAN tidsstämpel är inget bevis alls.
    const noTs = vesselAt(f, { _lastNorthProgress: { mps: f.northMps } });
    expect(app._getNotificationDirection(noTs, canalCandidate())).toBe('unknown');

    // OMLEVERANSFALLET (granskarsond 2026-08-22): byte-identisk omleverans
    // fryser lastPositionUpdate OCH stashen, men mottagningstiden (timestamp)
    // avancerar. Beviset räknas då som gammalt ⇒ 'unknown' — även om paret
    // {ts, lastPositionUpdate} fortfarande är identiskt.
    const t0 = Date.parse(f.cur.iso);
    const sameMessage = vesselAt(f, { timestamp: t0 });
    expect(app._getNotificationDirection(sameMessage, canalCandidate())).toBe('northbound');
    const redelivered = vesselAt(f, { timestamp: t0 + 70 * 1000 });
    expect(app._getNotificationDirection(redelivered, canalCandidate())).toBe('unknown');
  });

  test('den GAMLA stashformen (_lastNorthMps) får ALDRIG bära regeln', () => {
    // Halvlandad refaktorering är en äkta felmod: läser regeln fortfarande det
    // gamla skalära fältet blir färskhetskravet dekoration.
    const f = FIELD.balticJongleur;
    const legacy = {
      mmsi: f.mmsi,
      cog: f.cur.cog,
      sog: f.cur.sog,
      lastPositionUpdate: Date.parse(f.cur.iso),
      _lastNorthMps: f.northMps,
    };
    expect(app._getNotificationDirection(legacy, canalCandidate())).toBe('unknown');
  });

  test('regeln GISSAR ALDRIG söderut — negativ nordprogress ger okänd', () => {
    // En felaktig sydgissning aktiverar TRIGGER_POINT_SKIP-grinden (app.js
    // ~6907) och kan RADERA notiser som i dag går fram.
    const south = provenAt(-0.93, { mmsi: '9', cog: 60.4, sog: 4.2 });
    expect(app._getNotificationDirection(south, canalCandidate())).toBe('unknown');
  });

  test('regeln är ZON-LOKAL: samma bevis vid en BRO ändrar ingenting', () => {
    const v = vesselAt(FIELD.balticJongleur);
    for (const candidate of [
      {
        name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
      },
      {
        name: 'Olidebron', id: 'olidebron', distance: 180, source: 'current',
      },
      {
        name: 'Stridsbergsbron', id: 'stridsbergsbron', distance: 300, source: 'nearest',
      },
    ]) {
      expect(app._getNotificationDirection(v, candidate)).toBe('unknown');
    }
  });

  test('regeln kräver KÄLLAN trigger-point — exit-fallbacken vid samma punkt undantas', () => {
    // Exit-notisen är retroaktiv och per definition utgående; den ska inte
    // kunna få en nordgissning bara för att den bär bronamnet Kanalinfarten.
    const v = vesselAt(FIELD.balticJongleur);
    expect(app._getNotificationDirection(v, canalCandidate({ source: 'exit-fallback' }))).toBe('unknown');
    expect(app._getNotificationDirection(v, canalCandidate({ source: 'passage-fallback' }))).toBe('unknown');
  });

  test('östbandet 46–134° är regelns hela räckvidd', () => {
    const at = (cog) => app._getNotificationDirection(provenAt(0.6, { cog }), canalCandidate());
    // Innanför bandet: regeln slår.
    expect(at(46)).toBe('northbound');
    expect(at(90)).toBe('northbound');
    expect(at(134)).toBe('northbound');
    // Utanför: 45 och 135 ägs redan av _getDirectionString (nord resp. syd),
    // och regeln får inte flytta ett värde som inte var 'unknown'.
    expect(at(45)).toBe('northbound'); // via nordbandet, inte via K1
    expect(at(135)).toBe('southbound'); // sydtokenbandet — orört
    // Det ANDRA dödbandet (271–314°, VNV–NV) lämnas MEDVETET okänt: FP8 visade
    // att ingen legitim kanalfärd använder det.
    expect(at(290)).toBe('unknown');
    expect(at(314)).toBe('unknown');
  });

  test('utan mätning (nytt fartyg, inget stashat värde) ⇒ okänd', () => {
    expect(app._getNotificationDirection(
      { mmsi: '8', cog: 60.4, sog: 2.4 }, canalCandidate(),
    )).toBe('unknown');
    expect(app._getNotificationDirection(
      {
        mmsi: '8', cog: 60.4, sog: 2.4, lastPositionUpdate: 1, _lastNorthProgress: null,
      }, canalCandidate(),
    )).toBe('unknown');
    expect(app._getNotificationDirection(
      {
        mmsi: '8', cog: 60.4, sog: 2.4, lastPositionUpdate: 1, _lastNorthProgress: { mps: null, ts: 1 },
      }, canalCandidate(),
    )).toBe('unknown');
  });

  test('ruttlåset är fortsatt PRIMÄRT — K1 rör bara det som var okänt', () => {
    const locked = provenAt(0.9, {
      mmsi: '10', cog: 60.4, sog: 2.4, _routeDirection: 'south',
    });
    expect(app._getNotificationDirection(locked, canalCandidate())).toBe('southbound');
  });
});

describe('K1 steg 4 — hela notisvägen levererar den svenska tokenen', () => {
  let app;
  let fired;
  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    fired = [];
    app._triggerBoatNearFlowBest = jest.fn((tokens) => {
      fired.push(tokens);
      return Promise.resolve();
    });
  });

  const fieldVessel = (f) => {
    const ts = Date.parse(f.cur.iso);
    return {
      mmsi: f.mmsi,
      name: f.name,
      cog: f.cur.cog,
      sog: f.cur.sog,
      lastPositionUpdate: ts,
      _lastNorthProgress: { mps: f.northMps, ts },
    };
  };

  test('BALTIC JONGLEUR: safeTokens.direction = "norrut" (var "unknown" i fält)', async () => {
    await app._triggerBoatNearFlowForBridge(fieldVessel(FIELD.balticJongleur), canalCandidate());

    expect(fired).toHaveLength(1);
    expect(fired[0].direction).toBe('norrut');
    // Fältloggens rad 25996 bar `"direction":"unknown"` — det värdet får inte
    // finnas kvar någonstans i tokenen.
    expect(fired[0].direction).not.toBe('unknown');
    expect(fired[0].bridge_name).toBe('Kanalinfarten');
    // Ingen vakt-rad: 'northbound' står i vokabulären.
    expect(app.error).not.toHaveBeenCalledWith(expect.stringContaining('[DIR_TOKEN]'));
  });

  test('LADYBIRD: samma väg ger "okänd" — regeln övertriggar inte', async () => {
    await app._triggerBoatNearFlowForBridge(fieldVessel(FIELD.ladybird), canalCandidate());

    expect(fired).toHaveLength(1);
    expect(fired[0].direction).toBe('okänd');
  });

  test('F5: tokenen är SVENSK i alla tre lägena, aldrig ett internt ord', async () => {
    const cases = [
      [{
        mmsi: '21', name: 'N', sog: 5, cog: 20, _routeDirection: 'north',
      }, 'norrut'],
      [{
        mmsi: '22', name: 'S', sog: 5, cog: 200, _routeDirection: 'south',
      }, 'söderut'],
      [{
        mmsi: '23', name: 'U', sog: 0, cog: 90,
      }, 'okänd'],
    ];
    for (const [vessel, expected] of cases) {
      fired.length = 0;
      // eslint-disable-next-line no-await-in-loop
      await app._triggerBoatNearFlowForBridge(vessel, {
        name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
      });
      expect(fired[0].direction).toBe(expected);
      expect(['northbound', 'southbound', 'unknown']).not.toContain(fired[0].direction);
    }
  });

  test('DIR_TOKEN-VAKTEN: en ogiltig INTERN riktning loggas som fel', async () => {
    // toUserDirection sväljer skräp och svarar 'okänd' — rätt för användaren,
    // men det gör en framtida stavfelsretur ur riktningskedjan TYST: adaptern
    // i replayRunner översätter 'okänd' → 'unknown' och INV-2:s giltighets-
    // lista godkänner det. Vakten återställer skyddsnätet genom att LOGGA.
    app._getNotificationDirection = jest.fn(() => 'northboud');
    await app._triggerBoatNearFlowForBridge({
      mmsi: '31', name: 'TYPO', sog: 4, cog: 30,
    }, canalCandidate());

    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('[DIR_TOKEN]'));
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('northboud'));
    // Tokenen är fortfarande SÄKER — vakten loggar, den ändrar ingenting.
    expect(fired).toHaveLength(1);
    expect(fired[0].direction).toBe('okänd');
  });

  test('DIR_TOKEN-VAKTEN: prototypkedjan är INGEN giltig riktning', async () => {
    // INTERNAL_TO_USER är en objektliteral och ärver Object.prototype:
    // `INTERNAL_TO_USER['constructor']` är sanningsvärde true. Med ett rått
    // `if (KARTA[värde])`-uppslag hade tokenen blivit en FUNKTION.
    app._getNotificationDirection = jest.fn(() => 'constructor');
    await app._triggerBoatNearFlowForBridge({
      mmsi: '32', name: 'PROTO', sog: 4, cog: 30,
    }, canalCandidate());

    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('[DIR_TOKEN]'));
    expect(fired).toHaveLength(1);
    expect(fired[0].direction).toBe('okänd');
    expect(typeof fired[0].direction).toBe('string');
  });
});
