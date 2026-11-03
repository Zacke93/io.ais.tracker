'use strict';

jest.mock('homey');
const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { MOORING_ZONES } = require('../lib/constants');

/**
 * Helgranskningen 2026-11-03: "Kajen norr om Klaffbron" ligger mitt i
 * Klaffbrons väntzon och bär queueGraceMs (15 min) — förtöjnings-
 * klassningen räknar stillhet där som brokö. Öppningslagrets ankomstspärr
 * bekräftade ändå ett "kajstopp" efter 30 s i vilken kajzon som helst, så en
 * båt som väntat ut öppningen vid kajen fick ett andra kort för samma öppning
 * när hon lade ut (TIM och CHARLYS DREAM i both-21h, med båten isolerad).
 * Gästhamnen (queueGraceMs 0) behåller 30 s-regeln: där ÄR ett stopp ett
 * besök (HERA II).
 */
const MMSI = '265000222';
const KEY = `Klaffbron|${MMSI}|southbound`;
const KAJEN = MOORING_ZONES.find((zone) => zone.name === 'Kajen norr om Klaffbron');
const GASTHAMNEN = MOORING_ZONES.find((zone) => zone.name === 'Gästhamnen norr om Klaffbron');
const mid = (zone) => ({
  lat: (zone.start.lat + zone.end.lat) / 2,
  lon: (zone.start.lon + zone.end.lon) / 2,
});
// Utanför båda zonerna, söder om Kajen mot Klaffbron (≈115 m från Kajens mitt).
const DEPARTED = { lat: 58.2852955, lon: 12.2843295 };

describe('Öppningslagret: kort köstopp vid Kajen är samma ankomst', () => {
  let app;
  let savedMode;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-03T08:00:00Z'));
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    const store = {};
    app.homey = {
      ...mockHomey,
      settings: {
        get: (name) => store[name] ?? null,
        set: (name, value) => {
          store[name] = value;
        },
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    app._persistentOpeningWarnings.set(KEY, { arrivalActive: true, firedAt: Date.now() - 60000 });
    jest.spyOn(app.bridgeOpeningService, 'restartArrival');
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedMode;
  });

  const fix = (pos, sog) => ({
    mmsi: MMSI,
    lat: pos.lat,
    lon: pos.lon,
    sog,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
  });

  function stopThenDepart(zone, stopMs) {
    const at = mid(zone);
    app._observeOpeningArrivals(fix(at, 0.1));
    for (let elapsed = 30000; elapsed <= stopMs; elapsed += 30000) {
      jest.setSystemTime(Date.now() + 30000);
      app._observeOpeningArrivals(fix(at, 0.1));
    }
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix(DEPARTED, 3.0));
  }

  test('köstopp på 7 min vid Kajen ⇒ ankomstspärren står kvar, inget nytt kort', () => {
    expect(KAJEN.queueGraceMs).toBeGreaterThan(30000);
    stopThenDepart(KAJEN, 7 * 60 * 1000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
  });

  test('stopp som varat hela köskyddet vid Kajen ⇒ avgången är en ny ankomst', () => {
    stopThenDepart(KAJEN, KAJEN.queueGraceMs);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  test('övernattning vid Kajen med AIS-glapp: avgången nästa morgon är en ny ankomst', () => {
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0.1));
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(at, 0.1));
    // AIS avstängd över natten; nästa fix på samma plats tio timmar senare.
    jest.setSystemTime(Date.now() + 10 * 60 * 60 * 1000);
    app._observeOpeningArrivals(fix(at, 0.1));
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix(DEPARTED, 3.0));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  test('Gästhamnen: 60 s stopp räcker som förut (HERA II)', () => {
    expect(GASTHAMNEN.queueGraceMs || 0).toBe(0);
    stopThenDepart(GASTHAMNEN, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });
});
