'use strict';

// U59 (2026-11-24): efter ett långt stopp räknas restiden om från avgången
// (ProgressiveETACalculator._releaseStillBaseline). En båt som belagt legat
// still (U30-läget eller familj E:s avgångskontext) och sedan går i minst 2 kn,
// närmare målbron, får baslinjen från stillheten släppt: historiken töms och
// publiceringsklampen får engångssignalen _etaWaitingBaselineRelease.
// Varje villkor har ett fall precis innanför och utanför. Positionerna är
// syntetiska: en rak linje norr om Stridsbergsbron.

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const { BRIDGES } = require('../lib/constants');

const B = BRIDGES.stridsbergsbron;
const M_PER_DEG_LAT = 111320;
const MMSI = '900000059';
const MIN = 60000;

const logger = {
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

let calc;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-11-24T10:00:00Z') });
  calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
});
afterEach(() => {
  calc.destroy();
  jest.useRealTimers();
});

// En båt `northM` meter norr om Stridsbergsbron (söderut mot bron).
function vessel(northM, sog, extra = {}) {
  const now = Date.now();
  return {
    mmsi: MMSI,
    lat: B.lat + northM / M_PER_DEG_LAT,
    lon: B.lon,
    sog,
    cog: 180,
    status: 'en-route',
    targetBridge: 'Stridsbergsbron',
    _stationarySince: Date.parse('2026-11-24T10:00:00Z'),
    timestamp: now,
    lastPositionUpdate: now,
    fixTs: now,
    fixFeed: 'aisstream',
    ...extra,
  };
}

// U30-läget: stilla 900 m norr om bron i sex minuter (ett sampel per minut).
function enterStillUnknown() {
  for (let m = 0; m <= 6; m++) {
    if (m > 0) jest.advanceTimersByTime(MIN);
    calc._updateStillUnknown(vessel(900 + (m % 2), 0.1), 4);
  }
  expect(calc.isStillUnknown(MMSI)).toBe(true);
}

// En baslinje från stillheten: senaste historikposten 30 s gammal.
function staleHistory(processedETA) {
  return [{
    timestamp: Date.now() - 30000, processedETA, vesselSpeed: 0.1, distanceToTarget: 900,
  }];
}

// Ett avgångssampel: 30 s senare, `northM` meter norr om bron.
function departureSample(northM, sog, extra = {}) {
  jest.advanceTimersByTime(30000);
  const v = vessel(northM, sog, extra);
  return { v, position: calc._trustedETAPosition(v) };
}

describe('U59: baslinjen släpps efter U30-läget', () => {
  test('2,0 kn närmare bron släpper baslinjen; 1,9 kn gör det inte', () => {
    enterStillUnknown();
    const slow = departureSample(880, 1.9);
    const h1 = staleHistory(60);
    expect(calc._releaseStillBaseline(h1, slow.position, 7, slow.v)).toBe(false);
    expect(h1).toHaveLength(1);
    const brisk = departureSample(860, 2.0);
    const h2 = staleHistory(60);
    expect(calc._releaseStillBaseline(h2, brisk.position, 7, brisk.v)).toBe(true);
    expect(h2).toHaveLength(0);
  });

  test('baslinjen måste vara minst 1,5 gånger rå-ETA:n (monotoniskyddets gräns)', () => {
    enterStillUnknown();
    const a = departureSample(860, 3);
    expect(calc._releaseStillBaseline(staleHistory(30), a.position, 20.1, a.v)).toBe(false);
    expect(calc._releaseStillBaseline(staleHistory(30), a.position, 20, a.v)).toBe(true);
  });

  test('en båt som lägger ut bort från bron släpper inget', () => {
    enterStillUnknown();
    const away = departureSample(940, 4);
    expect(calc._releaseStillBaseline(staleHistory(60), away.position, 7, away.v)).toBe(false);
  });

  test('en fix som inte är nyare än lägets ankarpunkt är inget bevis', () => {
    enterStillUnknown();
    const anchorFix = calc._stillUnknown.get(MMSI).fixAt;
    const late = departureSample(860, 4, { fixTs: anchorFix });
    expect(calc._releaseStillBaseline(staleHistory(60), late.position, 7, late.v)).toBe(false);
  });

  test('ett GPS-hopp eller en osäker position släpper inget', () => {
    enterStillUnknown();
    const jump = departureSample(860, 4, { _gpsJumpDetected: true });
    expect(jump.position).toBeNull();
    expect(calc._releaseStillBaseline(staleHistory(60), jump.position, 7, jump.v)).toBe(false);
    const unsure = departureSample(850, 4, { _positionUncertain: true });
    expect(calc._releaseStillBaseline(staleHistory(60), unsure.position, 7, unsure.v)).toBe(false);
  });

  test('beviset förbrukas: ett släpp per bevis', () => {
    enterStillUnknown();
    const a = departureSample(860, 4);
    expect(calc._releaseStillBaseline(staleHistory(60), a.position, 7, a.v)).toBe(true);
    const b = departureSample(840, 4);
    expect(calc._releaseStillBaseline(staleHistory(60), b.position, 6.5, b.v)).toBe(false);
  });

  test('tom historik (gap-reseten i samma sampel) med bara U30-beviset: inget släpp', () => {
    // Fartbufferten bär då stillasamplet och rå-ETA:n är för hög (AIS-tystnad
    // över avgången gav "om 18" i stället för basens "om 15").
    enterStillUnknown();
    const a = departureSample(860, 4);
    expect(calc._releaseStillBaseline([], a.position, 7, a.v)).toBe(false);
    // Beviset är inte förbrukat: nästa sampel med historik släpper.
    const b = departureSample(840, 4);
    expect(calc._releaseStillBaseline(staleHistory(60), b.position, 6.5, b.v)).toBe(true);
  });

  test('annan målbro än lägets ger inget bevis', () => {
    enterStillUnknown();
    const a = departureSample(860, 4, { targetBridge: 'Klaffbron' });
    expect(calc._releaseStillBaseline(staleHistory(60), a.position, 7, a.v)).toBe(false);
  });
});

describe('U59: utan belagd stillhet släpps inget (en båt som bara saktar in)', () => {
  test.each([0.6, 1.0, 2.0])('%s kn i tio minuter och sedan 4 kn: inget bevis, inget släpp', (kn) => {
    // Ett sampel per minut i tio minuter i krypfarten (inget U30, ingen avgångskontext).
    for (let m = 0; m < 10; m++) {
      jest.advanceTimersByTime(MIN);
      const v = vessel(1500 - m * kn * 30.9, kn, { _stationarySince: null });
      calc.calculateProgressiveETA(v, null);
      calc.calculateProgressiveETA(v, null);
    }
    expect(calc.isStillUnknown(MMSI)).toBe(false);
    const a = departureSample(1500 - 10 * kn * 30.9 - 60, 4, { _stationarySince: null });
    expect(calc._releaseStillBaseline(staleHistory(60), a.position, 7, a.v)).toBe(false);
  });
});

describe('U59: baslinjen släpps efter familj E:s avgångskontext', () => {
  function sample(northM, sog) {
    jest.advanceTimersByTime(30000);
    const v = vessel(northM, sog, { status: 'passed', _stationarySince: null });
    calc._getEffectiveSpeed(v);
    calc._getEffectiveSpeed(v);
    return v;
  }

  test('belagd stillhet (två sampel under 0,5 kn) och avgång i 2,5 kn på platsen', () => {
    sample(500, 0.1);
    sample(499, 0.2);
    sample(498, 0.1);
    const v = sample(480, 2.5);
    expect(calc._departures.has(MMSI)).toBe(true);
    const h = staleHistory(13);
    expect(calc._releaseStillBaseline(h, calc._trustedETAPosition(v), 4, v)).toBe(true);
    expect(h).toHaveLength(0);
    // En gång per avgång.
    const w = sample(450, 3.5);
    expect(calc._releaseStillBaseline(staleHistory(13), calc._trustedETAPosition(w), 3.5, w)).toBe(false);
  });

  test('tom historik efter familj E:s avgång: publiceringsklampen släpps (rå-ETA:n utan väntans sampel)', () => {
    sample(500, 0.1);
    sample(499, 0.2);
    sample(498, 0.1);
    const v = sample(480, 2.5);
    expect(calc._releaseStillBaseline([], calc._trustedETAPosition(v), 4, v)).toBe(true);
  });

  test('kryp 0,6–0,9 kn är ingen belagd stillhet (familj E:s rörelsebevis)', () => {
    sample(500, 0.6);
    sample(499, 0.8);
    sample(498, 0.9);
    const v = sample(480, 2.5);
    expect(calc._departures.has(MMSI)).toBe(false);
    expect(calc._releaseStillBaseline(staleHistory(13), calc._trustedETAPosition(v), 4, v)).toBe(false);
  });
});

describe('U59 i hela kedjan: publiceringsklampen får signalen', () => {
  test('efter U30-läget och en avgång i 4 kn: historiken börjar om och signalen sätts', () => {
    enterStillUnknown();
    calc._etaHistory.set(MMSI, staleHistory(100));
    jest.advanceTimersByTime(30000);
    const v = vessel(850, 4);
    const eta = calc.calculateProgressiveETA(v, null);
    // 850 m i 4 kn (buffert [4]) ≈ 6,9 min, inte en blandning med 100.
    expect(eta).toBeLessThan(10);
    expect(v._etaWaitingBaselineRelease).toEqual({
      targetBridge: 'Stridsbergsbron', positionAt: v.lastPositionUpdate,
    });
  });

  test('utan stillhetsbevis står baslinjen kvar och ingen signal sätts', () => {
    calc._etaHistory.set(MMSI, staleHistory(100));
    jest.advanceTimersByTime(30000);
    const v = vessel(850, 4, { _stationarySince: null });
    const eta = calc.calculateProgressiveETA(v, null);
    expect(eta).toBeGreaterThan(50);
    expect(v._etaWaitingBaselineRelease).toBeUndefined();
  });
});
