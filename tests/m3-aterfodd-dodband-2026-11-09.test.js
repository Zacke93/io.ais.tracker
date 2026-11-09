'use strict';

/**
 * =============================================================================
 * M3 ÅTERFÖDD-DÖDBAND (rättningskampanjen varv 2, familj C, 2026-11-09)
 * =============================================================================
 *
 * FYNDET (buggjägarens F05-representant, värld 756): en ÅTERFÖDD båt vars enda
 * fix har kurs i dödbanden (46–134° eller 226–314°) fick ingen målbro.
 * _calculateTargetBridge avstår vid tvetydig kurs (F18), och ruttlåset ur
 * svepet sattes först senare i samma tick, i app-lagret
 * (_checkSkippedBridgesFallback, efter _observeBridgeOpening). Utan målbro
 * ingen arm, och utan arm ingen deadline när båten tystnade. FREJA korsade
 * Stridsbergsbron ovarnad under ett AIS-avbrott; deadlinen hade gått 400 s
 * före korsningen.
 *
 * RÄTTNINGEN: i ny-båtsgrenen får K1-mätningen mot sist kända position ur
 * SAMMA meddelande (_rebirthNorthBase) avgöra riktningen när den bevisar
 * transit: nettofart i nordled ≥ 2 kn, rapporterad fart ≥ 2 kn (Fix D:s
 * FIX_D_MIN_SOG) och kursen på samma sida som förflyttningen (östra
 * dödbandet = norrut, västra = söderut). Se
 * VesselDataService._rebirthTransitDirection.
 *
 * RÅDATAN är buggjägarens världar (repro-raderna, bitlika med korten i
 * varv 2:s triage) och fältbankens korpusar. Motexemplen under F18 är
 * konstruerade och märkta som sådana.
 *
 * KLOCKDOMÄNEN: posten i app._lastKnownPositions bär ingen fixTs, så
 * nordprogressen mäts på mottagningsklockan (se S5-testet). Testerna sätter
 * därför systemklockan i stället för att skicka fixTs.
 */

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { KN_TO_MPS } = require('../lib/utils/quayTransitProof');
const { MOORING_ZONES, BRIDGES } = require('../lib/constants');
const { buildPath, pathMetrics, pointAt } = require('./replay-validation/scenarioGenerator');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'm3-f05-freja-aterfodd-dodband.jsonl');
const RIBBA_MPS = 2.0 * KN_TO_MPS;
const M_PER_DEG_LAT = 111320;

// ---- RÅDATA: buggjägarens världar (repro.jsonl i varv 2:s kort) ----
// t = receivedAt i ms; bas = fixet före raderingen, åter = återfödelsen.
const FREJA = { // värld 756, F05-representanten, söderut mot Stridsbergsbron
  mmsi: '265172107',
  name: 'FREJA',
  bas: { t: Date.parse('2026-09-05T13:37:39.016Z'), lat: 58.320526813566175, lon: 12.323644282487805 },
  åter: {
    t: Date.parse('2026-09-05T13:44:47.134Z'), lat: 58.3074216012013, lon: 12.313119081766153, sog: 6.4, cog: 229.6,
  },
  mps: -3.408,
};
const HAVSORN = { // värld 1913, norrut mot Klaffbron (tredje återfödelsen)
  mmsi: '265629897',
  name: 'HAVSORN',
  bas: { t: Date.parse('2026-08-26T13:25:52.972Z'), lat: 58.26732656387994, lon: 12.267976432465513 },
  åter: {
    t: Date.parse('2026-08-26T13:38:12.231Z'), lat: 58.28087489030093, lon: 12.282691445747728, sog: 4.8, cog: 48.6,
  },
  mps: 2.040,
};
const PELLE = { // värld 977, norrut från Kanalinfarten; 1,2 % över ribban
  mmsi: '265369968',
  name: 'PELLE',
  bas: { t: Date.parse('2026-07-14T07:18:49.559Z'), lat: 58.26496911401062, lon: 12.263144562756636 },
  åter: {
    t: Date.parse('2026-07-14T07:22:35.453Z'), lat: 58.26708065213874, lon: 12.267350202022476, sog: 2.8, cog: 50.9,
  },
  mps: 1.041,
};

// ---- RÅDATA: fältbanken ----
// NORDIC SOLA 258715000, 20260713-41h (ais-replay-20260713-221737.jsonl): en
// kajavgång vid Kanalinfarten. Skissens första version (bara K1-ribban
// 0,25 m/s) gav henne målbro här och flyttade tre golden-text-rader till
// sämre; 2 kn-kravet är det som håller henne ute.
const NORDIC_SOLA = {
  mmsi: '258715000',
  name: 'NORDIC SOLA',
  bas: { t: 1784102960634, lat: 58.26570666666667, lon: 12.264425 },
  åter: {
    t: 1784103171439, lat: 58.266526666666664, lon: 12.267525000000001, sog: 3.2, cog: 46.5,
  },
  mps: 0.433,
};
// SY FREYJA 211351080, 20260702-2h (ais-replay-20260702-132758.jsonl): norr om
// Stridsbergsbron på väg ut ur kanalen. Beviset håller (norrut, kurs 45,1°),
// men norrut finns ingen målbro kvar; låset ska släppas så att svepet beter
// sig som förut. Det enda fall i banken där beviset håller.
const SY_FREYJA = {
  mmsi: '211351080',
  name: 'SY FREYJA',
  bas: { t: Date.parse('2026-07-02T12:34:44.220Z'), lat: 58.29953833333333, lon: 12.302086666666666 },
  åter: {
    t: Date.parse('2026-07-02T12:42:44.372Z'), lat: 58.307831666666665, lon: 12.31382, sog: 4.7, cog: 45.1,
  },
  mps: 1.923,
};

const k1 = (f) => ((f.åter.lat - f.bas.lat) * M_PER_DEG_LAT) / ((f.åter.t - f.bas.t) / 1000);

const liveServices = [];
function makeVds() {
  const logger = {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
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
  liveServices.push(svc);
  return svc;
}

/** Posten app.js:_onVesselRemoved skriver: {lat, lon, t = raderingstid, posT = positionens tid}. */
const seedLastKnown = (svc, f) => {
  svc.app._lastKnownPositions.set(f.mmsi, {
    lat: f.bas.lat, lon: f.bas.lon, t: f.bas.t + 120000, posT: f.bas.t,
  });
};

/** Återfödelsen genom den RIKTIGA updateVessel (ingen oldVessel). */
const reborn = (svc, f, patch = {}) => {
  seedLastKnown(svc, f);
  jest.setSystemTime(f.åter.t);
  return svc.updateVessel(f.mmsi, {
    lat: f.åter.lat, lon: f.åter.lon, sog: f.åter.sog, cog: f.åter.cog, name: f.name, ...patch,
  });
};

beforeEach(() => {
  global.__TEST_MODE__ = true;
  jest.useFakeTimers();
});
afterEach(() => {
  for (const svc of liveServices.splice(0)) svc.clearAllTimers();
  jest.useRealTimers();
  delete global.__TEST_MODE__;
});

describe('M3 steg 1 — rådatans egna tal', () => {
  test.each([
    ['FREJA (756)', FREJA], ['HAVSORN (1913)', HAVSORN], ['PELLE (977)', PELLE],
  ])('%s: kursen i dödbandet, nettofarten i nordled över 2 kn', (_namn, f) => {
    expect(k1(f)).toBeCloseTo(f.mps, 3);
    expect(Math.abs(k1(f))).toBeGreaterThanOrEqual(RIBBA_MPS);
    expect(f.åter.sog).toBeGreaterThanOrEqual(2);
    const östra = f.åter.cog > 45 && f.åter.cog < 135;
    const västra = f.åter.cog > 225 && f.åter.cog < 315;
    expect(östra || västra).toBe(true);
    // Kursens sida stämmer med förflyttningen.
    expect(östra).toBe(k1(f) > 0);
  });

  test('NORDIC SOLA (41h): 0,433 m/s ligger en faktor 2,4 under ribban, fast farten är 3,2 kn', () => {
    expect(k1(NORDIC_SOLA)).toBeCloseTo(NORDIC_SOLA.mps, 3);
    expect(RIBBA_MPS / k1(NORDIC_SOLA)).toBeGreaterThan(2.3);
    expect(NORDIC_SOLA.åter.sog).toBeGreaterThanOrEqual(2);
  });
});

describe('M3 steg 2 — RIKTIGA updateVessel: målbro och ruttlås i återfödelsens tick', () => {
  test('KÄRNAN (värld 756): FREJA söderut i 229,6° får Stridsbergsbron och låset söderut', () => {
    const svc = makeVds();
    const vessel = reborn(svc, FREJA);
    expect(vessel._lastNorthProgress.mps).toBeCloseTo(FREJA.mps, 3);
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel._routeDirection).toBe('south');
    expect(svc.logger.debug).toHaveBeenCalledWith(expect.stringContaining('[TARGET_ASSIGNMENT_REBIRTH]'));
  });

  test('värld 1913: HAVSORN norrut i 48,6° får Klaffbron och låset norrut', () => {
    const svc = makeVds();
    const vessel = reborn(svc, HAVSORN);
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._routeDirection).toBe('north');
  });

  test('värld 977: PELLE vid Kanalinfarten (1,041 m/s) får Klaffbron', () => {
    const svc = makeVds();
    const vessel = reborn(svc, PELLE);
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._routeDirection).toBe('north');
  });

  test('samma båt UTAN post i kartan (första kontakt) får ingen målbro, som förut', () => {
    const svc = makeVds();
    jest.setSystemTime(FREJA.åter.t);
    const vessel = svc.updateVessel(FREJA.mmsi, {
      lat: FREJA.åter.lat, lon: FREJA.åter.lon, sog: FREJA.åter.sog, cog: FREJA.åter.cog, name: FREJA.name,
    });
    expect(vessel._lastNorthProgress).toBeNull();
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
  });

  test('SY FREYJA (20260702-2h): beviset håller men målbro saknas norrut ⇒ låset släpps', () => {
    const svc = makeVds();
    const vessel = reborn(svc, SY_FREYJA);
    expect(vessel._lastNorthProgress.mps).toBeCloseTo(SY_FREYJA.mps, 3);
    expect(svc._rebirthTransitDirection(vessel, 2.0)).toBe('north');
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
  });
});

describe('M3 steg 3 — F18: motexemplen får ingen gissad målbro', () => {
  test('NORDIC SOLA (fältbanken, kajavgång vid Kanalinfarten): ingen målbro, inget lås', () => {
    const svc = makeVds();
    const vessel = reborn(svc, NORDIC_SOLA);
    expect(vessel._lastNorthProgress.mps).toBeCloseTo(NORDIC_SOLA.mps, 3);
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
  });

  // KONSTRUERAT: en båt som driver tvärs farleden (kurs 120°, 2,3 kn) har
  // flyttat sig 90 m mot OSO på 180 s. Nordkomponenten är −0,21 m/s.
  test('sidodrift: tvärs kanalen i 2,3 kn ger ingen målbro', () => {
    const svc = makeVds();
    const klaff = BRIDGES.klaffbron;
    const åter = { lat: klaff.lat - 500 / M_PER_DEG_LAT, lon: klaff.lon };
    const f = {
      mmsi: '901300001',
      name: 'DRIFT',
      bas: {
        t: Date.parse('2026-07-14T10:00:00Z'),
        lat: åter.lat + (90 * Math.cos((60 * Math.PI) / 180)) / M_PER_DEG_LAT,
        lon: åter.lon - (90 * Math.sin((60 * Math.PI) / 180)) / (M_PER_DEG_LAT * Math.cos((åter.lat * Math.PI) / 180)),
      },
      åter: {
        t: Date.parse('2026-07-14T10:03:00Z'), ...åter, sog: 2.3, cog: 120,
      },
    };
    expect(Math.abs(k1(f))).toBeLessThan(RIBBA_MPS / 4);
    const vessel = reborn(svc, f);
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
  });

  // KONSTRUERAT: GPS-hopp vid återfödelsen. (a) 900 m på 130 s överstiger
  // fysikens tak (5 kn × 130 s × 2 = 669 m): basen förkastas och ingen K1
  // mäts. (b) 300 m på 180 s är fysikaliskt möjligt (1,67 m/s), men båten
  // rapporterar 0,3 kn: ingen rörelse, alltså inget transitbevis.
  test('GPS-hopp (a): orimligt hopp ⇒ basen förkastas, ingen K1 och ingen målbro', () => {
    const svc = makeVds();
    const klaff = BRIDGES.klaffbron;
    const f = {
      mmsi: '901300002',
      name: 'HOPP-A',
      bas: { t: Date.parse('2026-07-14T10:00:00Z'), lat: klaff.lat - 1500 / M_PER_DEG_LAT, lon: klaff.lon - 0.004 },
      åter: {
        t: Date.parse('2026-07-14T10:02:10Z'), lat: klaff.lat - 600 / M_PER_DEG_LAT, lon: klaff.lon - 0.004, sog: 2.4, cog: 70,
      },
    };
    const vessel = reborn(svc, f);
    expect(vessel._lastNorthProgress).toBeNull();
    expect(vessel.targetBridge).toBeNull();
  });

  test('GPS-hopp (b): möjligt hopp men stillaliggande fart ⇒ inget bevis', () => {
    const svc = makeVds();
    const klaff = BRIDGES.klaffbron;
    const f = {
      mmsi: '901300003',
      name: 'HOPP-B',
      bas: { t: Date.parse('2026-07-14T10:00:00Z'), lat: klaff.lat - 700 / M_PER_DEG_LAT, lon: klaff.lon - 0.002 },
      åter: {
        t: Date.parse('2026-07-14T10:03:00Z'), lat: klaff.lat - 400 / M_PER_DEG_LAT, lon: klaff.lon - 0.002, sog: 0.3, cog: 80,
      },
    };
    expect(k1(f)).toBeGreaterThan(RIBBA_MPS);
    const vessel = reborn(svc, f);
    expect(vessel._lastNorthProgress.mps).toBeGreaterThan(RIBBA_MPS);
    expect(svc._rebirthTransitDirection(vessel, 2.0)).toBeNull();
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
  });

  // KONSTRUERAT: kajliggare i Gästhamnen (MOORING_ZONES), återfödd var tredje
  // minut med 20 m GPS-vobbel och en fartspik på 2,6 kn.
  test('kaj/Gästhamnen: vobbel och fartspik ger ingen målbro', () => {
    const svc = makeVds();
    const zon = MOORING_ZONES.find((z) => /Gästhamnen/.test(z.name));
    const mitt = { lat: (zon.start.lat + zon.end.lat) / 2, lon: (zon.start.lon + zon.end.lon) / 2 };
    const f = {
      mmsi: '901300004',
      name: 'KAJ',
      bas: { t: Date.parse('2026-07-14T10:00:00Z'), lat: mitt.lat - 10 / M_PER_DEG_LAT, lon: mitt.lon },
      åter: {
        t: Date.parse('2026-07-14T10:03:00Z'), lat: mitt.lat + 10 / M_PER_DEG_LAT, lon: mitt.lon, sog: 2.6, cog: 100,
      },
    };
    expect(Math.abs(k1(f))).toBeLessThan(RIBBA_MPS / 5);
    const vessel = reborn(svc, f);
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
  });

  // KONSTRUERAT (systerstället till kajgrinden, _slowInitialQuayApproachNeedsProof):
  // båten har legat vid sin kajplats i Gästhamnen i 6 min, gått ut söderut förbi
  // Klaffbron (en fix utanför kajbandet), raderats och återvänder nu i 2,5 kn med
  // kurs 80° in mot kajen. Förflyttningen sedan sist kända position är +1,25 m/s,
  // alltså över ribban, och kursens sida stämmer. Kajgrinden räknade sin målbro
  // ur kursen och var därför stum vid dödbandskurs; den prövas nu mot målbron
  // som beviset ger och håller henne, som den håller en båt med kurs i banden.
  test('kaj: återkomst till belagd kajplats i Gästhamnen ⇒ kajgrinden håller, ingen målbro', () => {
    const app = Object.create(AISBridgeApp.prototype);
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._openingQuayLedger = new Map();
    app._quayStableLedger = new Map();
    app._lastKnownPositions = new Map();
    const svc = makeVds();
    svc.app = app;
    const zon = MOORING_ZONES.find((z) => /Gästhamnen/.test(z.name));
    const kaj = { lat: (zon.start.lat + zon.end.lat) / 2, lon: (zon.start.lon + zon.end.lon) / 2 };
    const mmsi = '901300006';
    const t0 = Date.parse('2026-07-14T10:00:00Z');
    const fix = (t, pos, sog, cog) => ({
      mmsi, lat: pos.lat, lon: pos.lon, sog, cog, timestamp: t, lastPositionUpdate: t, fixTs: t, fixFeed: 'aisstream',
    });
    jest.setSystemTime(t0);
    app._noteQuayStability(fix(t0, kaj, 0.1, 0));
    jest.setSystemTime(t0 + 6 * 60000);
    app._noteQuayStability(fix(t0 + 6 * 60000, kaj, 0.1, 0));
    expect(app._openingQuayLedger.get(mmsi).positionStayEvidence).toBeTruthy();
    // 550 m söder om Klaffbron längs farleden: utanför kajbandet (> 500 m).
    const klaff = BRIDGES.klaffbron;
    const ute = {
      lat: klaff.lat - (550 * Math.cos((22 * Math.PI) / 180)) / M_PER_DEG_LAT,
      lon: klaff.lon - (550 * Math.sin((22 * Math.PI) / 180)) / (M_PER_DEG_LAT * Math.cos((klaff.lat * Math.PI) / 180)),
    };
    const t1 = t0 + 7 * 60000;
    jest.setSystemTime(t1);
    app._noteQuayStability(fix(t1, ute, 4.0, 200));
    expect(app._openingQuayLedger.get(mmsi)).toBeTruthy();
    const f = {
      mmsi,
      name: 'ÅTERKOMST',
      bas: { t: t1, ...ute },
      åter: {
        t: t1 + 700000, lat: kaj.lat + 10 / M_PER_DEG_LAT, lon: kaj.lon, sog: 2.5, cog: 80,
      },
    };
    expect(k1(f)).toBeGreaterThan(RIBBA_MPS);
    const vessel = reborn(svc, f);
    expect(svc._rebirthTransitDirection(vessel, 2.0)).toBe('north');
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
    expect(svc.logger.debug).toHaveBeenCalledWith(expect.stringContaining('[TARGET_QUAY_POSITION_PROOF]'));
  });

  test('kontroll: samma återkomst UTAN kajhistorik får målbro ur beviset', () => {
    const svc = makeVds();
    const zon = MOORING_ZONES.find((z) => /Gästhamnen/.test(z.name));
    const kaj = { lat: (zon.start.lat + zon.end.lat) / 2, lon: (zon.start.lon + zon.end.lon) / 2 };
    const klaff = BRIDGES.klaffbron;
    const ute = {
      lat: klaff.lat - (550 * Math.cos((22 * Math.PI) / 180)) / M_PER_DEG_LAT,
      lon: klaff.lon - (550 * Math.sin((22 * Math.PI) / 180)) / (M_PER_DEG_LAT * Math.cos((klaff.lat * Math.PI) / 180)),
    };
    const t1 = Date.parse('2026-07-14T10:07:00Z');
    const f = {
      mmsi: '901300007',
      name: 'TRANSIT',
      bas: { t: t1, ...ute },
      åter: {
        t: t1 + 700000, lat: kaj.lat + 10 / M_PER_DEG_LAT, lon: kaj.lon, sog: 2.5, cog: 80,
      },
    };
    const vessel = reborn(svc, f);
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel._routeDirection).toBe('north');
  });

  // KONSTRUERAT: vänd under avbrottet. Nettot sedan sist kända position säger
  // norr (+2,4 m/s), men kursen 250° (västra dödbandet, Fix D:s breda
  // sydband) säger att hon nu går söderut — och spegelbilden. Svepets
  // låsrelease (R1/F15) hade släppt svepets lås i båda fallen.
  test.each([
    ['norrut netto, kurs 250° nu', 1, 250],
    ['söderut netto, kurs 70° nu', -1, 70],
  ])('vänd under avbrottet (%s): ingen målbro i den gamla riktningen', (_namn, tecken, cog) => {
    const svc = makeVds();
    const strids = BRIDGES.stridsbergsbron;
    const åter = { lat: strids.lat - 900 / M_PER_DEG_LAT, lon: strids.lon - 0.006 };
    const f = {
      mmsi: '901300005',
      name: 'VÄND',
      bas: { t: Date.parse('2026-07-14T10:00:00Z'), lat: åter.lat - (tecken * 720) / M_PER_DEG_LAT, lon: åter.lon },
      åter: {
        t: Date.parse('2026-07-14T10:05:00Z'), ...åter, sog: 4.0, cog,
      },
    };
    expect(tecken * k1(f)).toBeGreaterThan(RIBBA_MPS);
    const vessel = reborn(svc, f);
    expect(svc._rebirthTransitDirection(vessel, 2.0)).toBeNull();
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBeNull();
  });
});

describe('M3 steg 4 — grindarna en och en (_rebirthTransitDirection)', () => {
  const ts = Date.parse('2026-07-14T10:00:00Z');
  const probe = (patch) => ({
    mmsi: '901300009',
    cog: 60,
    sog: 3,
    lastPositionUpdate: ts,
    timestamp: ts,
    _lastNorthProgress: { mps: 1.5, ts },
    ...patch,
  });

  test('ribborna är inklusiva: exakt 2 kn netto och exakt 2 kn fart räcker', () => {
    const svc = makeVds();
    expect(svc._rebirthTransitDirection(probe({ _lastNorthProgress: { mps: RIBBA_MPS, ts } }), 2.0)).toBe('north');
    expect(svc._rebirthTransitDirection(probe({ _lastNorthProgress: { mps: RIBBA_MPS * 0.99, ts } }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ sog: 2.0 }), 2.0)).toBe('north');
    expect(svc._rebirthTransitDirection(probe({ sog: 1.9 }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ sog: null }), 2.0)).toBeNull();
  });

  test('mätningen måste höra till detta meddelande (K1:s ts-kontrakt)', () => {
    const svc = makeVds();
    expect(svc._rebirthTransitDirection(probe({ _lastNorthProgress: { mps: 1.5, ts: ts - 1 } }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ timestamp: ts + 60000 }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ _lastNorthProgress: null }), 2.0)).toBeNull();
  });

  test('bara dödbanden: kurs i banden eller saknad kurs avgörs inte här', () => {
    const svc = makeVds();
    expect(svc._rebirthTransitDirection(probe({ cog: 45 }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ cog: 135 }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ cog: 225 }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ cog: 315 }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ cog: null }), 2.0)).toBeNull();
  });

  test('kursens sida: östra dödbandet bär norrut, västra söderut', () => {
    const svc = makeVds();
    const north = { mps: 1.5, ts };
    const south = { mps: -1.5, ts };
    expect(svc._rebirthTransitDirection(probe({ cog: 45.1, _lastNorthProgress: north }), 2.0)).toBe('north');
    expect(svc._rebirthTransitDirection(probe({ cog: 134.9, _lastNorthProgress: north }), 2.0)).toBe('north');
    expect(svc._rebirthTransitDirection(probe({ cog: 225.1, _lastNorthProgress: south }), 2.0)).toBe('south');
    expect(svc._rebirthTransitDirection(probe({ cog: 314.9, _lastNorthProgress: south }), 2.0)).toBe('south');
    expect(svc._rebirthTransitDirection(probe({ cog: 60, _lastNorthProgress: south }), 2.0)).toBeNull();
    expect(svc._rebirthTransitDirection(probe({ cog: 250, _lastNorthProgress: north }), 2.0)).toBeNull();
  });
});

describe('M3 steg 5 — ordningen mot app-lagrets ruttlås ur svepet', () => {
  let app;
  let savedTestMode;

  beforeEach(async () => {
    jest.setSystemTime(FREJA.bas.t - 1000);
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
    global.__TEST_MODE__ = undefined;
    app._isConnected = true;
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.restoreAllMocks();
    global.__TEST_MODE__ = savedTestMode;
  });

  const rows = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  async function feed(row) {
    await jest.advanceTimersByTimeAsync(row.aisTimestamp - Date.now());
    app._processAISMessage({
      ...row,
      mmsi: String(row.mmsi),
      timestamp: row.aisTimestamp,
      fixTs: row.aisTimestamp,
      fixFeed: 'aisstream',
      fixTsQuality: 'receipt',
    });
    await jest.advanceTimersByTimeAsync(0);
  }

  test('låset sätts i VDS före målbrovalet; svepet låser inte en gång till och bär samma riktning', async () => {
    const sweepTokens = [];
    const fallback = app._triggerBoatNearFlowFallback.bind(app);
    jest.spyOn(app, '_triggerBoatNearFlowFallback').mockImplementation(async (vessel, bridgeName, opts) => {
      sweepTokens.push([bridgeName, vessel._routeDirection]);
      return fallback(vessel, bridgeName, opts);
    });
    await feed(rows[0]); // 13:37:39 utanför kanalens gränser: ingen målbro
    expect(app.vesselDataService.getVessel(FREJA.mmsi).targetBridge).toBeNull();
    // Radering (5 min, > 4 kn) och sedan återfödelsen 13:44:47.
    await feed(rows[1]);
    const vessel = app.vesselDataService.getVessel(FREJA.mmsi);
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel._routeDirection).toBe('south');
    // Svepet körde (Stallbackabron i fönstret) men behövde inte låsa.
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('[SKIPPED_BRIDGES_CHECK] 265172107: new-vessel, direction=south'));
    expect(app.log).not.toHaveBeenCalledWith(expect.stringContaining('[SKIPPED_BRIDGES_DIRECTION_LOCK]'));
    expect(app.log).not.toHaveBeenCalledWith(expect.stringContaining('[SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED]'));
    expect(sweepTokens).toEqual([['Stallbackabron', 'south']]);
    // Armen finns i samma tick: deadlinen kan gå i tystnaden.
    expect(app.bridgeOpeningService._arms.has(`${FREJA.mmsi}::Stridsbergsbron`)).toBe(true);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('[OPENING_ARM] 265172107 (FREJA): beväpnad mot Stridsbergsbron'));
  });
});

describe('M3 steg 6 — hela appen på buggjägarens minsta repro (värld 756)', () => {
  test('Stridsbergsbron#1 avfyras av äggklockan i avbrottet, 400 s före korsningen', () => {
    const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
    delete env.REPLAY_MONITORING;
    const out = execFileSync(process.execPath, [
      path.join(ROOT, 'tests/replay-validation/replayRunner.js'), FIXTURE,
    ], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    });
    const result = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    const strids = result.openingWarnings.filter((w) => w.bridge === 'Stridsbergsbron');
    expect(strids).toHaveLength(1);
    expect(strids[0]).toMatchObject({ firedBy: 'deadline', direction: 'southbound', leadMmsi: FREJA.mmsi });
    // Sann korsning 13:54:34,202 (buggjägarens L0, repro.truth.json);
    // avbrottet 13:45:02–13:57:23.
    expect(strids[0].iso).toBe('2026-09-05T13:47:54.060Z');
    expect(1788616474201.8433 - strids[0].t).toBeGreaterThanOrEqual(400000);
    // Klaffbron-varningen efter avbrottet står kvar.
    expect(result.openingWarnings.filter((w) => w.bridge === 'Klaffbron')).toHaveLength(1);
  }, 120000);
});

// Granskningen av familj C (2026-11-09, L1): dödbandet skyddar inte längre en
// återfödd båt mot falsklarm i de klasser där en båt med kurs i banden redan i dag
// får målbro. Varje sådan värld ger EXAKT tvillingens utfall: samma värld med
// kurs 25° (nordbandet) vid återfödelsen, som c14938f behandlar på samma sätt.
// Testerna låser det, så att en framtida skärpning (t.ex. en zonvakt bara för M3)
// blir ett medvetet beslut. Världarna är granskarens W1 och W3 (advgen.js).
describe('M3 steg 7 — residualen: samma utfall som tvillingen med kurs i banden', () => {
  const P = buildPath();
  const MET = pathMetrics(P);
  const { cum } = MET; // 1 Olidebron, 2 Klaffbron, 3 Järnvägsbron, 4 Stridsbergsbron
  const T0 = Date.UTC(2026, 6, 20, 10, 0, 0);
  const at = (s) => pointAt(P, MET, s);
  const row = (mmsi, name, tS, pos, sog, cog) => {
    const ts = T0 + Math.round(tS * 1000);
    return {
      mmsi,
      msgType: 'StandardClassBPositionReport',
      lat: pos.lat,
      lon: pos.lon,
      sog,
      cog,
      navStatus: null,
      shipName: name,
      aisTimestamp: ts,
      receivedAt: new Date(ts).toISOString(),
    };
  };
  // W1: vändningen PÅGÅR vid återfödelsen 389 m söder om Klaffbron (kurs 100° i
  // östra dödbandet, netto norrut); därefter ger hon upp och går söderut.
  const w1 = (mmsi, kurs) => {
    const rows = [row(mmsi, 'VAND-NARA', 0, at(cum[1] + 683), 3.8, 50)];
    rows.push(row(mmsi, 'VAND-NARA', 150, at(cum[2] - 389), 3.0, kurs));
    for (let t = 180, s = cum[2] - 400; s >= cum[1] - 600; t += 30, s -= 3.5 * KN_TO_MPS * 30) {
      rows.push(row(mmsi, 'VAND-NARA', t, at(s), 3.5, 202));
    }
    return rows;
  };
  // W3: första ankomst till Gästhamnen efter ett avbrott, utan kajhistorik
  // (kurs 95° på väg in), sedan förtöjd.
  const w3 = (mmsi, kurs) => {
    const zon = MOORING_ZONES.find((z) => /Gästhamnen/.test(z.name));
    const kaj = { lat: (zon.start.lat + zon.end.lat) / 2, lon: (zon.start.lon + zon.end.lon) / 2 };
    const rows = [row(mmsi, 'GASTHAMN', 0, at(cum[1] + 683), 3.8, 50)];
    rows.push(row(mmsi, 'GASTHAMN', 480, at(cum[2] + 300), 2.6, kurs));
    rows.push(row(mmsi, 'GASTHAMN', 540, { lat: kaj.lat, lon: kaj.lon - 0.0003 }, 0.9, 100));
    for (let t = 660; t <= 3600; t += 180) {
      rows.push(row(mmsi, 'GASTHAMN', t, { lat: kaj.lat + ((t / 180) % 2) * 0.00002, lon: kaj.lon }, 0.0, null));
    }
    return rows;
  };
  const replay = (rows, namn) => {
    const fil = path.join(os.tmpdir(), `m3-tvilling-${namn}-${process.pid}.jsonl`);
    fs.writeFileSync(fil, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    try {
      const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
      delete env.REPLAY_MONITORING;
      const out = execFileSync(process.execPath, [
        path.join(ROOT, 'tests/replay-validation/replayRunner.js'), fil,
      ], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
      });
      return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    } finally {
      fs.unlinkSync(fil);
    }
  };
  const utfall = (r) => ({
    processfel: r.processErrors,
    varningar: r.openingWarnings.map((w) => [w.bridge, w.iso, w.firedBy, w.direction, w.etaMin]),
    texter: r.bridgeTextTransitions.map((t) => [t.iso, t.text]),
    notiser: r.notifications.map((n) => [n.t, n.bridge, n.direction, n.eta]),
    passager: r.targetPassages.map((p) => [p.t, p.bridge]),
  });

  test.each([
    ['W1, vändning vid återfödelsen (kurs 100°)', w1, 100, ['Klaffbron', '2026-07-20T10:02:30.000Z', 'fix']],
    ['W3, första ankomst till Gästhamnen (kurs 95°)', w3, 95, ['Stridsbergsbron', '2026-07-20T10:08:00.000Z', 'fix']],
  ])('%s: samma varning och text som tvillingen med kurs 25°', (namn, varld, kurs, varning) => {
    const dodband = utfall(replay(varld('901900301', kurs), 'dodband'));
    const tvilling = utfall(replay(varld('901900391', 25), 'tvilling'));
    expect(dodband.processfel).toBe(0);
    expect(dodband.varningar.map((w) => w.slice(0, 3))).toEqual([varning]);
    expect(dodband).toEqual(tvilling);
  }, 120000);
});
