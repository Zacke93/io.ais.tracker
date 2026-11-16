'use strict';

// U30 (2026-11-15): läget "ETA okänd" för en bevisat stilla båt utanför
// väntzonen (ProgressiveETACalculator._updateStillUnknown). Varje villkor har
// ett fall precis innanför och utanför (granskningen av b9c581a, M1).
// Positionerna är syntetiska: en rak linje norr om Stridsbergsbron.

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const { BRIDGES } = require('../lib/constants');

const B = BRIDGES.stridsbergsbron;
const M_PER_DEG_LAT = 111320;
const T0 = 1800000000000;
const MMSI = '900000030';
const MIN = 60000;

function makeCalculator() {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  const registry = {
    getBridgeByName: (name) => (name === 'Stridsbergsbron' ? B : { lat: B.lat - 0.0084, lon: B.lon - 0.01, name }),
  };
  return new ProgressiveETACalculator(logger, registry);
}

let now = T0;
beforeEach(() => {
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

// En båt `northM` meter norr om bron, stilla sedan `stillSinceMin` min före nu.
function vessel(northM, extra = {}) {
  return {
    mmsi: MMSI,
    lat: B.lat + northM / M_PER_DEG_LAT,
    lon: B.lon,
    sog: 0.1,
    cog: 200,
    status: 'approaching',
    targetBridge: 'Stridsbergsbron',
    _stationarySince: T0,
    timestamp: now,
    lastPositionUpdate: now,
    fixTs: now,
    fixFeed: 'aisstream',
    ...extra,
  };
}

// Kör ett sampel per minut i `minutes` minuter; returnerar läget efter varje.
function run(calc, minutes, build) {
  const states = [];
  for (let m = 0; m <= minutes; m++) {
    now = T0 + m * MIN;
    const v = build(m);
    calc._updateStillUnknown(v, 4);
    states.push(calc.isStillUnknown(MMSI));
  }
  return states;
}

describe('U30: läget "ETA okänd" går in', () => {
  test('efter fem minuters stillhet 460 m från bron, inte före', () => {
    const calc = makeCalculator();
    const states = run(calc, 6, () => vessel(460));
    expect(states.slice(0, 5).every((x) => !x)).toBe(true);
    expect(states[5]).toBe(true);
  });

  test('350 m-gränsen: 360 m går in, 340 m inte (status approaching i båda)', () => {
    expect(run(makeCalculator(), 6, () => vessel(360))[6]).toBe(true);
    expect(run(makeCalculator(), 10, () => vessel(340))[10]).toBe(false);
  });

  test('inte i annan status än approaching, inte med imminent-flaggan', () => {
    expect(run(makeCalculator(), 8, () => vessel(460, { status: 'waiting' }))[8]).toBe(false);
    expect(run(makeCalculator(), 8, () => vessel(460, { _isImminentAtTargetBridge: true }))[8]).toBe(false);
  });

  test('inte på en gammal position (hasFreshPosition)', () => {
    const calc = makeCalculator();
    const states = run(calc, 12, (m) => {
      const v = vessel(460);
      if (m >= 1) {
        // Sista positionen och mottagningen var vid minut 1; nu är den gammal.
        v.timestamp = T0 - 11 * MIN; v.lastPositionUpdate = T0 - 11 * MIN; v.fixTs = T0 - 11 * MIN;
      }
      return v;
    });
    expect(states.some((x) => x)).toBe(false);
  });

  test('inte med GPS-hopp eller osäker position', () => {
    expect(run(makeCalculator(), 8, () => vessel(460, { _gpsJumpDetected: true }))[8]).toBe(false);
    expect(run(makeCalculator(), 8, () => vessel(460, { _positionUncertain: true }))[8]).toBe(false);
  });

  test('inte vid fart 0,5 kn eller mer, och inte utan VDS:s stillhetsklocka', () => {
    expect(run(makeCalculator(), 8, () => vessel(460, { sog: 0.5 }))[8]).toBe(false);
    expect(run(makeCalculator(), 8, () => vessel(460, { _stationarySince: null }))[8]).toBe(false);
    // Klockan har gått fem minuter men positionen har inte legat still i fem
    // minuter: båten kom fram för två minuter sedan.
    const calc = makeCalculator();
    const states = run(calc, 7, (m) => vessel(m < 5 ? 460 + (5 - m) * 100 : 460, { _stationarySince: T0 - 10 * MIN }));
    expect(states[6]).toBe(false);
    expect(states[7]).toBe(false);
  });
});

describe('U30: läget hålls och lämnas', () => {
  const entered = () => {
    const calc = makeCalculator();
    run(calc, 6, () => vessel(460));
    expect(calc.isStillUnknown(MMSI)).toBe(true);
    return calc;
  };
  const step = (calc, m, v) => {
    now = T0 + m * MIN;
    calc._updateStillUnknown({
      ...v, timestamp: now, lastPositionUpdate: now, fixTs: now,
    }, 4);
    return calc.isStillUnknown(MMSI);
  };

  test('fartspikar utan förflyttning lämnar inte läget (1,5 och 3 kn, moget ankare)', () => {
    const calc = entered();
    for (let m = 7; m < 47; m++) {
      expect(step(calc, m, vessel(460 + (m % 2), { sog: m % 2 ? 3 : 0.1, _stationarySince: T0 }))).toBe(true);
    }
  });

  test('belagd rörelse: 49 m från ankaret står kvar, 51 m lämnar läget', () => {
    const calc = entered();
    expect(step(calc, 7, vessel(460 - 49, { sog: 0.6 }))).toBe(true);
    expect(step(calc, 8, vessel(460 - 51, { sog: 0.6 }))).toBe(false);
  });

  // Granskningen 2026-11-16 (L-A): bara en position som är nyare än lägets
  // ankarpunkt är bevis för rörelse.
  test('en gammal fix (äldre än ankarpunkten) 58 m bort lämnar inte läget; en ny gör det', () => {
    const calc = entered();
    now = T0 + 11 * MIN;
    // AISHub-eko: fixTs 10 min före nu, alltså före ankarpunkten (minut 5).
    const echo = vessel(460 - 58, {
      sog: 2, fixFeed: 'aishub', fixTs: now - 10 * MIN, timestamp: now, lastPositionUpdate: now,
    });
    calc._updateStillUnknown(echo, 4);
    expect(calc.isStillUnknown(MMSI)).toBe(true);
    // Samma plats i en ny fix är belagd rörelse.
    expect(step(calc, 12, vessel(460 - 58, { sog: 2 }))).toBe(false);
  });

  test('en gammal fix flyttar inte heller stillhetsbevakningen', () => {
    const calc = makeCalculator();
    run(calc, 3, () => vessel(460));
    const watch = { ...calc._stillWatch.get(MMSI) };
    now = T0 + 4 * MIN;
    calc._updateStillUnknown(vessel(460 - 58, {
      sog: 2, fixFeed: 'aishub', fixTs: T0 - 2 * MIN, timestamp: now, lastPositionUpdate: now,
    }), 4);
    expect(calc._stillWatch.get(MMSI)).toEqual(watch);
    // Läget går in efter fem minuter på platsen, som utan ekot.
    now = T0 + 5 * MIN;
    calc._updateStillUnknown(vessel(460), 4);
    expect(calc.isStillUnknown(MMSI)).toBe(true);
  });

  test('en GPS-misstänkt position långt bort lämnar inte läget', () => {
    const calc = entered();
    expect(step(calc, 7, vessel(200, { _gpsJumpDetected: true }))).toBe(true);
    expect(step(calc, 8, vessel(200, { _positionUncertain: true }))).toBe(true);
  });

  test('målbyte, statusbyte och imminent-flaggan lämnar läget', () => {
    expect(step(entered(), 7, vessel(460, { targetBridge: 'Klaffbron' }))).toBe(false);
    expect(step(entered(), 7, vessel(460, { status: 'en-route' }))).toBe(false);
    expect(step(entered(), 7, vessel(460, { _isImminentAtTargetBridge: true }))).toBe(false);
  });

  test('clearVesselETAHistory tar bort läget', () => {
    const calc = entered();
    calc.clearVesselETAHistory(MMSI, 'target_bridge_change_Stridsbergsbron_to_none');
    expect(calc.isStillUnknown(MMSI)).toBe(false);
  });

  test('nytt inträde efter belagd rörelse kräver fem minuters stillhet på den nya platsen', () => {
    const calc = entered();
    expect(step(calc, 7, vessel(400, { sog: 0.2 }))).toBe(false);
    // Stillhetsklockan i VDS har överlevt (drift under 0,3 kn), men den nya
    // platsen har inte legat stilla fem minuter.
    for (let m = 8; m <= 11; m++) expect(step(calc, m, vessel(400))).toBe(false);
    expect(step(calc, 12, vessel(400))).toBe(true);
  });

  test('inträdet kräver ett rent sampel även när platsen legat stilla fem minuter', () => {
    const calc = makeCalculator();
    // Fem minuter rent och stilla men med fart 0,6 kn (inget inträde), sedan ett
    // GPS-misstänkt sampel under 0,5 kn.
    run(calc, 5, () => vessel(460, { sog: 0.6 }));
    expect(calc.isStillUnknown(MMSI)).toBe(false);
    expect(step(calc, 6, vessel(460, { _gpsJumpDetected: true }))).toBe(false);
    expect(step(calc, 7, vessel(460))).toBe(true);
  });

  test('stillheten räknas bara i status approaching: fem minuter waiting räknas inte', () => {
    const calc = makeCalculator();
    run(calc, 6, () => vessel(460, { status: 'waiting' }));
    expect(calc.isStillUnknown(MMSI)).toBe(false);
    for (let m = 7; m <= 11; m++) expect(step(calc, m, vessel(460))).toBe(false);
    expect(step(calc, 12, vessel(460))).toBe(true);
  });

  test('utträdet nollställer platsbevakningen även när platsen ligger nära den gamla', () => {
    const calc = makeCalculator();
    // Bevakningen startar på 460 m; läget går in på 430 m (30 m bort, samma plats).
    run(calc, 4, () => vessel(460));
    expect(step(calc, 5, vessel(430))).toBe(true);
    // 52 m från lägets ankarpunkt men bara 22 m från bevakningens: läget lämnas.
    expect(step(calc, 6, vessel(482, { sog: 0.6 }))).toBe(false);
    // Ett nytt inträde kräver fem nya minuter, trots att den gamla bevakningens
    // plats ligger inom 50 m.
    for (let m = 7; m <= 10; m++) expect(step(calc, m, vessel(482))).toBe(false);
    expect(step(calc, 11, vessel(482))).toBe(true);
  });
});
