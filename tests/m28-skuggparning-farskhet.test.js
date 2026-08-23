'use strict';

/**
 * M28 (helkodsgranskning runda 4, 2026-08-23) — SKUGGPARNINGENS FÄRSKHETSVAL.
 *
 * _findShadowCounterpart sveper 3×3 rutor kring meddelandets position och ska
 * välja den FÄRSKASTE motparten (största storedAt) bland dem inom
 * PAIR_MATCH_DIST_M. Jämförelsen läste `best.storedAt` — ett fält som inte finns
 * på best-objektet ({side, key, entry, other}) — så uttrycket blev
 * `side.storedAt > undefined` = alltid false och den FÖRSTA rutan i
 * svepordningen vann. Skuggmätaren (fixLag-medianen) bytte därmed tecken
 * (−7 396 → +12 051 ms, 71 → 79 par) — instrumentet som källbesluten vilar på.
 *
 * Testet lägger en ÄLDRE motpart i rutan som sveps först (dLat −1, dLon −1)
 * och en FÄRSKARE i en senare ruta (+1, +1), båda inom 1,5 m, och kräver att
 * den färskare väljs. Med felet (best.storedAt) vinner den äldre.
 */

const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');

function makeLogger() {
  return {
    log() {}, error() {}, debug() {}, warn() {},
  };
}
function makeStore() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), unset: (k) => m.delete(k) };
}

describe('M28: skuggparningen väljer den FÄRSKASTE motparten, inte den första i svepordningen', () => {
  test('äldre motpart i första svepta rutan, färskare i en senare ⇒ den färskare vinner', () => {
    const mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const mmsi = '265999000';
    const lat0 = 58.28;
    const lon0 = 12.28;
    const D = 1e-5;
    const now = 1_787_000_000_000;
    const older = {
      deliveryTs: now - 60_000, fixTs: now - 61_000, lat: lat0 - D, lon: lon0 - D, storedAt: now - 60_000,
    };
    const fresher = {
      deliveryTs: now - 1_000, fixTs: now - 2_000, lat: lat0 + D, lon: lon0 + D, storedAt: now - 1_000,
    };
    // Produktionens nyckel: sidans EGEN position, utan offset.
    mux._shadowPosIndex.set(AISSourceMultiplexer._gridKey(mmsi, older.lat, older.lon), {
      storedAt: older.storedAt, aishub: older,
    });
    mux._shadowPosIndex.set(AISSourceMultiplexer._gridKey(mmsi, fresher.lat, fresher.lon), {
      storedAt: fresher.storedAt, aishub: fresher,
    });

    const best = mux._findShadowCounterpart('aisstream', {
      mmsi, lat: lat0, lon: lon0, fixTs: now, deliveryTs: now,
    });
    expect(best).not.toBeNull();
    expect(best.other).toBe('aishub');
    expect(best.side.storedAt).toBe(fresher.storedAt);
  });

  test('ensam motpart inom rutsvepet väljs oavsett ruta', () => {
    const mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    const mmsi = '265999001';
    const side = {
      deliveryTs: 1, fixTs: 1, lat: 58.28 - 1e-5, lon: 12.28, storedAt: 1,
    };
    mux._shadowPosIndex.set(AISSourceMultiplexer._gridKey(mmsi, side.lat, side.lon), { storedAt: 1, aishub: side });
    const best = mux._findShadowCounterpart('aisstream', {
      mmsi, lat: 58.28, lon: 12.28, fixTs: 2, deliveryTs: 2,
    });
    expect(best && best.side).toBe(side);
  });
});
