'use strict';

/**
 * Rättning M02 (motorgranskningen 2026-11-04): radions rörelsetillstånd är
 * fysiskt. En båt som rör sig (|v| > 0) rapporterar sog = |v| i knop och cog
 * längs rörelsen även i krypfart, och stillaliggarmodellen (sog 0 eller brus
 * kring 0, slumpad eller saknad cog, stillakadens) gäller bara vid v = 0.
 *
 * Den gamla radion räknade |v| < 0,25 m/s (≈ 0,49 kn) som stilla och fäller
 * fallen i 0,3 och 0,4 kn: sog 0 i R0, och i R1 stillabrus, slumpad cog och
 * stillakadens. Ren generering: inga barnprocesser, ingen replay, inga timers.
 */

const geo = require('../lib/geo');
const families = require('../lib/families');
const { deepFreeze } = require('../lib/rng');
const { simulateWorld, truthAt, KN } = require('../lib/world');
const { observeWorld } = require('../lib/radio');

const T0 = Date.UTC(2026, 6, 1, 8, 0, 0);
const M_PER_DEG_LAT = 111320;
const S_KLAFF = geo.stationByName.Klaffbron.s;

/** En värld med en båt som kryper i `kn` genom Klaffbron, 600 m före till 600 m efter. */
function crawlSim({
  kn, cls = 'A', era = 'aisstream', dir = 'north',
}) {
  const sign = dir === 'north' ? 1 : -1;
  const boat = {
    mmsi: '265000301',
    name: 'KRYPARE',
    cls,
    role: 'transit',
    dir,
    tStartS: 60,
    sStart: S_KLAFF - (sign * 600),
    sEnd: S_KLAFF + (sign * 600),
    cruiseKn: 5,
    v0Kn: kn,
    laneM: 0,
    queueLaneM: 0,
    lateralSigma: 0,
    plan: [{
      op: 'crawl', bridge: 'Klaffbron', withinM: 99999, kn,
    }],
    tags: [],
    seed: 3,
  };
  return simulateWorld(deepFreeze({
    version: 1, seed: 301, startMs: T0, durS: 3 * 3600, era, boats: [boat], events: [], radioSeed: 301,
  }));
}

/** Banpunkten för en rad (samma avrundning som radion använder). */
const pointOf = (sim, r) => truthAt(sim.boats[0], (r.fixTs - T0) / 1000);

/** Positionsraderna där båten kryper med exakt `kn` enligt L0. */
function crawlRows(sim, rows, kn) {
  return rows.filter((r) => !r.ctrl).map((r) => ({ r, p: pointOf(sim, r) }))
    .filter(({ p }) => p && p.phase === 'crawl' && Math.abs(Math.abs(p.v) - (kn * KN)) < 1e-9);
}

/** Rörelseriktningen (grader) ur banans positioner, oberoende av radions kurs. */
function motionBearing(sim, r) {
  const tS = (r.fixTs - T0) / 1000;
  const a = truthAt(sim.boats[0], tS);
  const z = truthAt(sim.boats[0], tS + 1);
  const dy = (z.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (z.lon - a.lon) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return (((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360;
}

const angDiff = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
/** Tid (s) mellan på varandra följande krypfixar. */
const gapsS = (list) => list.slice(1).map(({ r }, k) => (r.fixTs - list[k].r.fixTs) / 1000);

describe('R0: krypfart rapporteras fysiskt', () => {
  test.each(['north', 'south'])('0,3 kn %s ger sog 0,3 och cog längs rörelsen på varje rad', (dir) => {
    const sim = crawlSim({ kn: 0.3, dir });
    const crawl = crawlRows(sim, observeWorld(sim, { profile: 'R0' }).rows, 0.3);
    expect(crawl.length).toBeGreaterThan(100);
    expect([...new Set(crawl.map(({ r }) => r.sog))]).toEqual([0.3]);
    const worst = Math.max(...crawl.map(({ r }) => angDiff(r.cog, motionBearing(sim, r))));
    expect(worst).toBeLessThan(1);
    // Under gång (klass A) i rörelse.
    expect(crawl.every(({ r }) => r.navStatus === 0)).toBe(true);
  });

  test('F-KRYP:s fartintervall 0,4–1,5 kn rapporteras fysiskt, även nedre kanten', () => {
    for (const kn of [0.4, 0.5, 1.0, 1.5]) {
      const sim = crawlSim({ kn });
      const crawl = crawlRows(sim, observeWorld(sim, { profile: 'R0' }).rows, kn);
      expect(crawl.length).toBeGreaterThan(10);
      expect([kn, [...new Set(crawl.map(({ r }) => r.sog))]]).toEqual([kn, [kn]]);
    }
  });

  test('genererade F-KRYP-världar: den fokala båtens krypfixar bär familjens fart', () => {
    let prövade = 0;
    for (let i = 0; i < 6; i++) {
      const spec = families.sampleWorld(4711, 300 + i, { family: 'F-KRYP', hours: 2 });
      const { kn } = spec.fokal.parametrar;
      expect(kn).toBeGreaterThanOrEqual(0.4);
      expect(kn).toBeLessThanOrEqual(1.5);
      const sim = simulateWorld(deepFreeze(spec));
      const focal = sim.boats.find((b) => b.spec.mmsi === spec.fokal.mmsis[0]);
      const { rows } = observeWorld(sim, { profile: 'R0' });
      const crawl = rows.filter((r) => r.mmsi === focal.spec.mmsi)
        .map((r) => ({ r, p: truthAt(focal, (r.fixTs - spec.startMs) / 1000) }))
        .filter(({ p }) => p && p.phase === 'crawl' && Math.abs(Math.abs(p.v) - (kn * KN)) < 1e-9);
      if (!crawl.length) continue;
      prövade++;
      expect([kn, [...new Set(crawl.map(({ r }) => r.sog))]]).toEqual([kn, [kn]]);
    }
    expect(prövade).toBeGreaterThanOrEqual(4);
  });
});

describe('R1: fartbrus kring den fysiska farten, inte stillabrus', () => {
  test.each([
    ['A', 'aisstream'],
    ['B', 'aishub'],
  ])('0,3 kn, klass %s, %s: sog nära 0,3, cog längs rörelsen och rörelsekadens', (cls, era) => {
    const sim = crawlSim({ kn: 0.3, cls, era });
    const crawl = crawlRows(sim, observeWorld(sim, { profile: 'R1' }).rows, 0.3);
    expect(crawl.length).toBeGreaterThan(3);
    const sogs = crawl.map(({ r }) => r.sog);
    const mean = sogs.reduce((s, x) => s + x, 0) / sogs.length;
    expect(Math.abs(mean - 0.3)).toBeLessThan(0.06);
    expect(sogs.filter((x) => x === 0).length / sogs.length).toBeLessThan(0.15);
    // cog finns på varje rad och följer rörelsen inom fältets cog-fel (p50 2,8°, p90 9,8°).
    expect(crawl.filter(({ r }) => r.cog === null)).toHaveLength(0);
    expect(median(crawl.map(({ r }) => angDiff(r.cog, motionBearing(sim, r))))).toBeLessThan(10);
    // Rörelsekadens: stillaregimens golv är 170 s, transitregimens median ligger under,
    // så de 71 minuternas krypning ger fler än 20 fixar.
    expect(median(gapsS(crawl))).toBeLessThan(170);
    expect(crawl.length).toBeGreaterThan(20);
  });
});

describe('v = 0: stillaliggarmodellen gäller fortfarande', () => {
  const queueSim = () => {
    const boat = {
      mmsi: '265000302',
      name: 'KÖAREN',
      cls: 'A',
      role: 'transit',
      dir: 'south',
      tStartS: 60,
      sStart: S_KLAFF + 1500,
      sEnd: S_KLAFF - 600,
      cruiseKn: 4,
      v0Kn: 4,
      laneM: 0,
      queueLaneM: 0,
      lateralSigma: 0,
      plan: [{
        op: 'queue', bridge: 'Klaffbron', distM: 250, durS: 2400,
      }],
      tags: [],
      seed: 4,
    };
    return simulateWorld(deepFreeze({
      version: 1, seed: 302, startMs: T0, durS: 3 * 3600, era: 'aisstream', boats: [boat], events: [], radioSeed: 302,
    }));
  };
  const waitRows = (sim, rows) => rows.filter((r) => !r.ctrl).map((r) => ({ r, p: pointOf(sim, r) }))
    .filter(({ p }) => p && p.phase === 'queue' && p.v === 0);

  test('R0: väntan i kö ger sog 0', () => {
    const sim = queueSim();
    const wait = waitRows(sim, observeWorld(sim, { profile: 'R0' }).rows);
    expect(wait.length).toBeGreaterThan(50);
    expect([...new Set(wait.map(({ r }) => r.sog))]).toEqual([0]);
  });

  test('R1: väntan i kö ger stillabrus och stillakadens (minst 170 s)', () => {
    const sim = queueSim();
    const wait = waitRows(sim, observeWorld(sim, { profile: 'R1' }).rows);
    expect(wait.length).toBeGreaterThanOrEqual(3);
    expect(wait.every(({ r }) => r.sog >= 0 && r.sog <= 0.4)).toBe(true);
    expect(Math.min(...gapsS(wait))).toBeGreaterThanOrEqual(170);
  });

  test('kajliggare av klass A: sog 0 och navStatus 5', () => {
    const quay = { lat: geo.pointAt(1200, 40).lat, lon: geo.pointAt(1200, 40).lon };
    const sim = simulateWorld(deepFreeze({
      version: 1,
      seed: 303,
      startMs: T0,
      durS: 3600,
      era: 'aisstream',
      boats: [{
        mmsi: '265000303', name: 'KAJAN', cls: 'A', role: 'moored', quay, tStartS: 0, durS: 3600, tags: [], seed: 5,
      }],
      events: [],
      radioSeed: 303,
    }));
    const rows = observeWorld(sim, { profile: 'R0' }).rows.filter((r) => !r.ctrl);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((r) => r.sog === 0 && r.navStatus === 5)).toBe(true);
  });
});
