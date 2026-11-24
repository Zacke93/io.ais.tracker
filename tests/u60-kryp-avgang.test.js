'use strict';

// U60 AVSTÅTT (dirigentens beslut 2026-11-24): KÄND GRÄNS. Familj E:s avgång
// kräver att de buffrade samplen är under 0,5 kn. En båt som kryper i kön
// (0,5–0,99 kn) och sedan sätter fart får därför inget avgångsgolv: farten
// räknas på buffertens snitt, och första siffran efter krypet blir för hög
// (KINNE, fältprov 2, 22/11: "om 10" där 3,6 återstod, kortet 8 där 2,2
// återstod). En regel som känner igen avgången ur kryp prövades (U60) och
// avstods: ett ryck i kön går inte att skilja från avgången (U56:s lärdom),
// och i rycksvepet gav den klart för låg text i 32 av 2 112 byggda världar,
// upp till 16 min lägre än i dag. Testen låser dagens beteende; den som
// inför en krypregel måste låsa om dem medvetet (ARCHITECTURE §8 e, "Känd
// gräns: ingen avgång ur kryp"). Positionerna är syntetiska: en rak linje
// söder om Stridsbergsbron (norrut mot bron).

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const { BRIDGES } = require('../lib/constants');

const STRIDS = BRIDGES.stridsbergsbron;
const M_PER_DEG_LAT = 111320;
const MMSI = '900000060';

const logger = {
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

let calc;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-11-24T20:40:00Z') });
  calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
});
afterEach(() => {
  calc.destroy();
  jest.useRealTimers();
});

function sample(southM, sog) {
  jest.advanceTimersByTime(60000);
  const now = Date.now();
  const v = {
    mmsi: MMSI,
    lat: STRIDS.lat - southM / M_PER_DEG_LAT,
    lon: STRIDS.lon,
    sog,
    cog: 30,
    status: 'waiting',
    targetBridge: 'Stridsbergsbron',
    timestamp: now,
    lastPositionUpdate: now,
  };
  return { first: calc._getEffectiveSpeed(v), second: calc._getEffectiveSpeed(v), v };
}

describe('U60 avstått: ingen avgång ur kryp (känd gräns)', () => {
  test('kryp 0,5–0,9 kn och sedan 2,1 kn på platsen: inget golv, buffertens snitt (KINNE-formen)', () => {
    sample(640, 0.6);
    sample(620, 0.9);
    sample(600, 0.5);
    const dep = sample(560, 2.1);
    expect(calc._departures.has(MMSI)).toBe(false);
    expect(dep.first).toBeCloseTo((0.9 + 0.5 + 2.1) / 3, 5);
    expect(dep.second).toBeCloseTo((0.9 + 0.5 + 2.1) / 3, 5);
  });

  test('samma kryp och sedan 3,5 kn: fortfarande ingen avgång', () => {
    sample(640, 0.7);
    sample(620, 0.8);
    sample(600, 0.7);
    sample(560, 3.5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  test('motfallet som avgår i dag: stillhet under 0,5 kn och 2,1 kn ger golvet 4 kn', () => {
    sample(640, 0.1);
    sample(620, 0.3);
    sample(600, 0.2);
    const dep = sample(560, 2.1);
    expect(calc._departures.has(MMSI)).toBe(true);
    expect(dep.first).toBe(4);
  });

  test('LA FEMME-klassen lämnas orörd: en stale-hold över en buffert helt under 1 kn ger ingen avgång', () => {
    sample(1300, 0.9);
    sample(1250, 0.5);
    sample(1235, 0.1);
    calc.armStationaryHold(MMSI, 'eta_stale_hard');
    expect(sample(1234, 0.3).first).toBeNull();
    expect(sample(1233, 0.4).first).toBeNull();
    const { first } = sample(1120, 4.5);
    expect(calc._departures.has(MMSI)).toBe(false);
    expect(first).toBeCloseTo((0.5 + 0.1 + 4.5) / 3, 5);
  });
});
