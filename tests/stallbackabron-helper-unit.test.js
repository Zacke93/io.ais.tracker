'use strict';

const StallbackabronHelper = require('../lib/utils/StallbackabronHelper');

/**
 * Minimalt kontraktstest för StallbackabronHelper.
 *
 * BEDÖMNING (2026-07-03): modulen är en BORTTAGNINGSKANDIDAT.
 *  - Enda innehållet är den statiska metoden isStallbackabron(name).
 *  - Metoden anropas INTE någonstans i produktionskoden.
 *  - StatusService instansierar klassen med `new StallbackabronHelper(
 *    bridgeRegistry, logger)` — argumenten ignoreras (ingen konstruktor
 *    finns) och instansen används aldrig.
 * All Stallbackabron-logik ligger inline i BridgeTextService (se modulens
 * egen kommentar). Testet nedan låser bara det triviala namnkontraktet så
 * att en framtida borttagning/ändring blir synlig.
 */
describe('StallbackabronHelper — minimalt namnkontrakt (borttagningskandidat)', () => {
  test('exakt namnet "Stallbackabron" känns igen', () => {
    expect(StallbackabronHelper.isStallbackabron('Stallbackabron')).toBe(true);
  });

  test('andra broar, annan skiftläggning och tomma värden ger false', () => {
    expect(StallbackabronHelper.isStallbackabron('Klaffbron')).toBe(false);
    expect(StallbackabronHelper.isStallbackabron('stallbackabron')).toBe(false);
    expect(StallbackabronHelper.isStallbackabron('')).toBe(false);
    expect(StallbackabronHelper.isStallbackabron(null)).toBe(false);
    expect(StallbackabronHelper.isStallbackabron(undefined)).toBe(false);
  });

  test('klassen kan instansieras utan argument (bakåtkompatibilitet i StatusService)', () => {
    expect(() => new StallbackabronHelper()).not.toThrow();
  });
});
