'use strict';

jest.mock('homey');

const { parseEnvelope } = require('../lib/utils/aishubParser');
const AISBridgeApp = require('../app');

/**
 * H34 (helkodsgranskning runda 1, 2026-08-22) — COG UTANFÖR 0-360
 * NORMALISERAS INTE, OCH HELA POSITIONSRAPPORTEN DÖR.
 *
 * aishubParser fångade BARA exakt 360. Rå COG 3601-4095 (AIS-fältet är
 * tiondels grader) avkodas till 360,1-409,5 och passerade därför som en
 * "kurs". Nedströms fäller app.js _validateAISMessage HELA rapporten på ett
 * COG utanför 0-360 — fartyget blir osynligt trots giltig position, exakt
 * den klass som SOG-sentinelen 102,3 en gång orsakade (och som B1/A2-2
 * stängde för farten: null, positionen behålls). I both-läget är följden
 * värre än en tappad rapport: muxen bokför fixen FÖRE appvalideringen, så
 * även nästa giltiga hubbfix avvisas som stale_cross_fix.
 *
 * Parsern speglar nu app-sidans regel: cog = null, POSITIONEN BEHÅLLS.
 */

function makeMeta(overrides = {}) {
  return {
    ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: 1, ...overrides,
  };
}

function makeRecord(overrides = {}) {
  return {
    MMSI: 265001111,
    TIME: '2026-08-02 12:00:00 GMT',
    LATITUDE: 58.29,
    LONGITUDE: 12.29,
    COG: 25.5,
    SOG: 5.2,
    NAVSTAT: 0,
    NAME: 'TESTBAT',
    ...overrides,
  };
}

const body = (meta, records) => JSON.stringify([meta, records]);
const parseCog = (raw) => parseEnvelope(body(makeMeta(), [makeRecord({ COG: raw })]));

describe('H34: COG utanför 0-360 blir null i aishubParser', () => {
  test.each([
    // Restklassen som INTE kan komma ur fuzzvärden: rå 3601-4095.
    [360.1, null], [409.5, null], [361, null],
    // Övrig skräpklocka i båda riktningar.
    [720, null], [-10, null], [-0.1, null], ['409.5', null],
    // Sentinelen och de giltiga värdena är oförändrade (ingen regression).
    [360, null], [359.9, 359.9], [0, 0], [25.5, 25.5], [null, null],
  ])('COG %p → %p', (raw, expected) => {
    expect(parseCog(raw).records[0].cog).toBe(expected);
  });

  test('POSITIONEN BEHÅLLS: posten dör inte av en skräpkurs', () => {
    const res = parseCog(409.5);
    expect(res.records).toHaveLength(1);
    const rec = res.records[0];
    expect(rec.lat).toBe(58.29);
    expect(rec.lon).toBe(12.29);
    expect(rec.sog).toBe(5.2); // farten rörs inte av kursgrinden
    expect(rec.mmsi).toBe('265001111');
  });
});

describe('H34: konsekvensen nedströms — appen tappar inte längre båten', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._replayCaptureFile = null;
    app.vesselDataService = { updateVessel: jest.fn() };
    return app;
  }

  test('parserns post (cog null) passerar appvalideringen med behållen position', () => {
    const app = makeApp();
    const rec = parseCog(409.5).records[0];
    expect(rec.cog).toBeNull();
    app._processAISMessage({ ...rec, timestamp: Date.now() });
    expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
    const patch = app.vesselDataService.updateVessel.mock.calls[0][1];
    expect(patch.cog).toBeNull();
    expect(patch.lat).toBe(58.29);
  });

  test('SAMMA REGEL I BÅDA LAGREN: appens egen grind gör likadant med rå 409,5', () => {
    // Appnivån är försvar på djupet och äger sin egen normalisering. Att
    // parsern ändå gör jobbet är inte dubbelarbete: muxen bokför fixen via
    // applyAccept FÖRE appvalideringen, så fusionens F1/F2/F6-state är det
    // ENDA lagret som ser hubbens råa värde — den vägen stängs bara här.
    const app = makeApp();
    const rec = parseCog(409.5).records[0];
    app._processAISMessage({ ...rec, cog: 409.5, timestamp: Date.now() });
    expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
    expect(app.vesselDataService.updateVessel.mock.calls[0][1].cog).toBeNull();
  });
});
