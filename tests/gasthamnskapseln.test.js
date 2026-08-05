'use strict';

/**
 * B3 (etapp 7, 2026-08-05): gästhamnskapseln — MOORING_ZONES-posten
 * 'Gästhamnen norr om Klaffbron'.
 *
 * Bakgrund (both-dygn 1): gästhamnen ~520 m N om Klaffbron var dygnets
 * dominerande falsklarmskälla (68 % av all felaktig brotext, flertalet
 * fantomvarningar; 7 fartyg, 1 842 min stilltid, navStatus null/15 hos alla
 * — navstatuslagret blint). GO-rapportens varning: kapseln får INTE bygga på
 * ren geometri, eftersom äkta Klaffbron-passager går nära — skyddet är
 * stillhetskravet i konsumtionslagren. Testerna låser därför BÅDA benen:
 *   1. GEOMETRIN (datahärledd ur fältdygnen 2026-08-04/05, riktiga koordinater):
 *      stillhetsklustret inne, farledens transitspår (≥5 kn, ≥40 m väster) ute.
 *   2. KONSUMTIONEN: stationär i kapseln ⇒ moored + aldrig målbro (LAGER 1);
 *      rörlig genom kapseln (in-/utgångsmanöver 2–3 kn) ⇒ ALDRIG moored,
 *      behåller målbro.
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { MOORING_ZONES } = require('../lib/constants');

const ZONE = MOORING_ZONES.find((z) => z.name === 'Gästhamnen norr om Klaffbron');

// Riktiga fältsampel (both-dygn 1 + GO-dygnet):
const STILLA_TRUNTEN = { lat: 58.28715, lon: 12.28554 }; // sog 0, 219031577
const STILLA_CENTER = { lat: 58.28740, lon: 12.285705 }; // klustrets mitt
const FARLED_CARAT_74KN = { lat: 58.2875, lon: 12.28499 }; // sog 7,4 — transit väster om hamnen
const MANOVER_27KN = { lat: 58.28766, lon: 12.28571 }; // sog 2,7 — utgångsmanöver genom kapseln

const segDist = (p) => geometry.distancePointToSegmentM(
  p.lat, p.lon, ZONE.start.lat, ZONE.start.lon, ZONE.end.lat, ZONE.end.lon,
);

describe('B3: gästhamnskapselns geometri (datahärledd)', () => {
  test('zonen finns med kapselkontraktets fyra fält', () => {
    expect(ZONE).toBeDefined();
    expect(Number.isFinite(ZONE.start.lat) && Number.isFinite(ZONE.end.lon)).toBe(true);
    expect(ZONE.radiusM).toBe(35);
  });

  test('stillhetsklustrets sampel ligger INNE i kapseln', () => {
    expect(segDist(STILLA_TRUNTEN)).toBeLessThanOrEqual(ZONE.radiusM);
    expect(segDist(STILLA_CENTER)).toBeLessThanOrEqual(ZONE.radiusM);
  });

  test('farledens transitspår (7,4 kn) ligger UTANFÖR kapseln med marginal', () => {
    expect(segDist(FARLED_CARAT_74KN)).toBeGreaterThan(ZONE.radiusM + 5);
  });

  test('kapseln når inte Klaffbrons väntzon (≤300 m) — ingen väntare kan demoteras', () => {
    const KLAFFBRON = { lat: 58.28248, lon: 12.28331 };
    const dStart = geometry.calculateDistance(
      ZONE.start.lat, ZONE.start.lon, KLAFFBRON.lat, KLAFFBRON.lon,
    );
    expect(dStart - ZONE.radiusM).toBeGreaterThan(300 + 100); // >100 m marginal till väntzonen
  });
});

describe('B3: konsumtionen — stillhet krävs, rörelse skyddar', () => {
  let svc;
  let mockNow;
  const realDateNow = Date.now;
  const logger = {
    debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 7, 5, 10, 0, 0).getTime();
    Date.now = () => mockNow;

    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    svc = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
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
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  function tick(minutes = 1) {
    mockNow += minutes * 60 * 1000;
  }

  test('_findMooringZone träffar gästhamnen för klustrets position', () => {
    const zone = svc._findMooringZone({ lat: STILLA_CENTER.lat, lon: STILLA_CENTER.lon });
    expect(zone && zone.name).toBe('Gästhamnen norr om Klaffbron');
  });

  test('LAGER 1: gästhamnsliggare (CARAT-klassen) får ALDRIG målbro och klassas moored', () => {
    // Both-dygn 1: CARAT låg här med navStatus null och fick 97,6 min falsk
    // "på väg mot Klaffbron"-text. Med kapseln: stationär + i zonen ⇒ moored.
    let vessel;
    for (let i = 0; i < 5; i++) {
      vessel = svc.updateVessel('211452170', {
        lat: STILLA_TRUNTEN.lat, lon: STILLA_TRUNTEN.lon, sog: 0.0, cog: 128, name: 'CARAT',
      });
      tick(3);
    }
    expect(vessel._moored).toBe(true);
    expect(vessel.targetBridge).toBeNull();
  });

  test('rörlig båt SÖDERUT genom kapseln (utgångsmanöver) klassas ALDRIG moored', () => {
    // Avgång ur gästhamnen: 2–3 kn genom kapseln på väg mot Klaffbron.
    // Stillhetskravet skyddar — geometrisk träff räcker inte.
    const path = [
      { lat: 58.28790, lon: 12.28575, sog: 2.2 }, // norr om kapseln
      { lat: MANOVER_27KN.lat, lon: MANOVER_27KN.lon, sog: 2.7 }, // inne i kapseln
      { lat: 58.28730, lon: 12.28568, sog: 3.1 }, // fortfarande inne, på väg syd
      { lat: 58.28640, lon: 12.28540, sog: 3.8 }, // ute ur kapseln, mot bron
    ];
    let vessel;
    for (const p of path) {
      vessel = svc.updateVessel('265788210', {
        lat: p.lat, lon: p.lon, sog: p.sog, cog: 195, name: 'EUGENIE',
      });
      tick(1);
    }
    expect(vessel._moored).not.toBe(true);
    expect(vessel.targetBridge).toBe('Klaffbron');
  });
});
