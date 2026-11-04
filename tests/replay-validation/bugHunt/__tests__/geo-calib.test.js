'use strict';

/**
 * Buggjägaren steg 7: geometri, PRNG och fryst kalibrering.
 * Inga barnprocesser och inga timers.
 */

const geo = require('../lib/geo');
const rng = require('../lib/rng');
const cal = require('../lib/calib');
const { computeBankHash } = require('../lib/bankHash');
const gt = require('../../makeGtPassages');

/** Brytpunkternas avböjning (grader, + = högersväng norrut) ur farledens segment. */
function vertices() {
  const { legs } = geo.FW;
  const brg = legs.map((L) => {
    const mLon = 111320 * Math.cos((L.a.lat * Math.PI) / 180);
    return (((Math.atan2((L.b.lon - L.a.lon) * mLon, (L.b.lat - L.a.lat) * 111320) * 180) / Math.PI) + 360) % 360;
  });
  return legs.slice(1).map((L, i) => ({ s: L.cum, defl: ((brg[i + 1] - brg[i] + 540) % 360) - 180 }));
}

/**
 * Inre skuggzon: på kurvans insida, inom |l|·tan(|δ|/2) från en brytpunkt,
 * finns ingen punkt vars närmaste segment ger tillbaka (s, |l|). Där kan
 * ingen invers vara exakt; felet är då begränsat av zonens bredd.
 */
function innerShadow(s, l) {
  if (l === 0) return null;
  for (const v of vertices()) {
    const inner = (v.defl < 0 && l < 0) || (v.defl > 0 && l > 0);
    const half = Math.abs(l) * Math.tan((Math.abs(v.defl) * Math.PI) / 360);
    if (inner && Math.abs(s - v.s) <= half + 0.5) return { ...v, half };
  }
  return null;
}

describe('geo: farledens invers', () => {
  test('project(pointAt(s, l)) ger s och |l| inom 0,01 m utanför kurvornas inre skuggzoner', () => {
    const shadowed = [];
    for (let s = 0; s <= 7000; s += 250) {
      for (const l of [-20, 0, 20]) {
        const p = geo.pointAt(s, l);
        const q = geo.project(p.lat, p.lon);
        const err = Math.max(Math.abs(q.s - s), Math.abs(q.offsetM - Math.abs(l)));
        const sh = innerShadow(s, l);
        if (sh) {
          shadowed.push(`${s}/${l}`);
          // Inne i skuggzonen: felet är begränsat av zonens dubbla bredd.
          expect(err).toBeLessThanOrEqual((2 * sh.half) + 0.5);
        } else {
          expect(err).toBeLessThan(0.01);
        }
      }
    }
    // Exakt två rutnätspunkter ligger 0,3–0,4 m från en vänsterbrytpunkt.
    expect(shadowed).toEqual(['1500/-20', '5500/-20']);
  });

  test('på centerlinjen är inversen exakt även tätt (s −200…7000 i steg om 7 m)', () => {
    for (let s = -200; s <= 7000; s += 7) {
      const p = geo.pointAt(s, 0);
      const q = geo.project(p.lat, p.lon);
      expect(Math.abs(q.s - s)).toBeLessThan(0.01);
      expect(q.offsetM).toBeLessThan(0.01);
    }
  });

  test('stationernas s-värden är rådatafacitets BRIDGE_STATIONS', () => {
    expect(geo.STATIONS.map((b) => [b.name, b.s])).toEqual(gt.BRIDGE_STATIONS.map((b) => [b.name, b.s]));
    expect(geo.S_K).toBeGreaterThan(290);
    expect(geo.S_K).toBeLessThan(300);
  });

  test('mitt mellan Järnvägsbron och Stridsbergsbron blir närmaste notispunkt den bro som ligger närmast', () => {
    const mid = (geo.stationByName['Järnvägsbron'].s + geo.stationByName.Stridsbergsbron.s) / 2;
    for (const [ds, want] of [[-25, 'Järnvägsbron'], [25, 'Stridsbergsbron']]) {
      const p = geo.pointAt(mid + ds, 0);
      const n = geo.nearestNoticePoint(p.lat, p.lon);
      expect(n.name).toBe(want);
      const other = want === 'Järnvägsbron' ? 'Stridsbergsbron' : 'Järnvägsbron';
      expect(n.distM).toBeLessThan(geo.distToPoint(p.lat, p.lon, other));
      expect(n.distM).toBeLessThan(300);
    }
    const k = geo.pointAt(geo.S_K, 0);
    expect(geo.nearestNoticePoint(k.lat, k.lon).name).toBe('Kanalinfarten');
  });

  test('radioboxen och sektorerna', () => {
    const inside = geo.pointAt(2000, 0);
    const south = geo.pointAt(-350, 0);
    const north = geo.pointAt(7150, 0);
    expect(geo.inRadioBox(inside.lat, inside.lon)).toBe(true);
    expect(geo.inRadioBox(south.lat, south.lon)).toBe(false);
    expect(geo.inRadioBox(north.lat, north.lon)).toBe(false);
    expect(geo.sectorOf(100)).toBe('0 S-om-infarten');
    expect(geo.sectorOf(2500)).toBe('3 Klaff–Jvb');
    expect(geo.sectorOf(6000)).toBe('6 N-om-Stallbacka');
  });
});

describe('rng: seedade strömmar', () => {
  test('samma seed och etikett ger samma ström, olika etiketter olika strömmar', () => {
    const a = rng.stream(7, 'radio-265000001');
    const b = rng.stream(7, 'radio-265000001');
    const c = rng.stream(7, 'radio-265000002');
    const d = rng.stream(8, 'radio-265000001');
    const xa = Array.from({ length: 20 }, () => a.u());
    const xb = Array.from({ length: 20 }, () => b.u());
    const xc = Array.from({ length: 20 }, () => c.u());
    const xd = Array.from({ length: 20 }, () => d.u());
    expect(xa).toEqual(xb);
    expect(xa).not.toEqual(xc);
    expect(xa).not.toEqual(xd);
    for (const x of xa) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  test('deriveSeed är stabil, i [1; 2^31 − 1] och skiljer index åt', () => {
    expect(rng.deriveSeed(1, 'värld-0')).toBe(rng.deriveSeed(1, 'värld-0'));
    expect(rng.deriveSeed(1, 'värld-0')).not.toBe(rng.deriveSeed(1, 'värld-1'));
    const s = rng.deriveSeed(123456, 'värld-42');
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(2147483647);
  });

  test('hashfunktionerna ger samma värde två gånger och är nyckelordningsoberoende', () => {
    const rows = [{
      mmsi: '265000001', aisTimestamp: 1.78e12, lat: 58.28, lon: 12.28,
    }];
    expect(rng.hashRows(rows)).toBe(rng.hashRows(JSON.parse(JSON.stringify(rows))));
    expect(rng.hashJson({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(rng.hashJson({ b: [2, { d: 4, c: 3 }], a: 1 }));
    const h1 = computeBankHash();
    const h2 = computeBankHash();
    expect(h1.sha256).toBe(h2.sha256);
    expect(h1.filer).toHaveLength(24);
    expect(h1.filer.filter((f) => f.state)).toHaveLength(4);
  });

  test('deepFreeze gör att skrivförsök kastar i strict mode', () => {
    const o = rng.deepFreeze({ a: { b: [1, 2] } });
    expect(() => {
      o.a.b.push(3);
    }).toThrow();
    expect(() => {
      o.a.c = 1;
    }).toThrow();
  });
});

describe('calib: fryst kalibrering', () => {
  test('filen bär källa, datum och bankens hash', () => {
    expect(cal.CAL._om.frystDatum).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cal.CAL._om['källor']).toHaveLength(2);
    expect(cal.CAL.bank.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cal.CAL.bank.filer).toHaveLength(24);
    expect(cal.QUAYS).toHaveLength(12);
  });

  test('köplatserna är designens fyra (BUGGJAKT.md §4.4)', () => {
    expect(cal.QUEUE_SITES.map((q) => `${q.bridge} ${q.dir} ${q.distM.join('–')}`)).toEqual([
      'Stridsbergsbron south 80–193',
      'Järnvägsbron north 121–278',
      'Järnvägsbron south 56–180',
      'Klaffbron south 221–307',
    ]);
  });

  test('samplarna återger fältets kvantiler (klass B i transit p50 ≈ 121 s; kö p50 15 min)', () => {
    const r = rng.stream(1, 'kalibrering');
    const draw = (fn, n = 4000) => Array.from({ length: n }, () => fn(r.u())).sort((a, b) => a - b);
    const b = draw(cal.cadence.aisstream.B.move);
    expect(b[2000]).toBeGreaterThan(100);
    expect(b[2000]).toBeLessThan(140);
    const qd = draw(cal.queueDurMin);
    expect(qd[2000]).toBeGreaterThan(12);
    expect(qd[2000]).toBeLessThan(18);
    expect(qd[qd.length - 1]).toBeLessThanOrEqual(cal.SPEC['kö']['äktaKöer'].durationMin.p99 + 1e-9);
    const sampler = cal.quantileSampler({
      p10: 1, p25: 2, p50: 3, p75: 4, p90: 5, p95: 6, p99: 7, max: 70,
    });
    expect(sampler(0.5)).toBeCloseTo(3);
    expect(sampler(1)).toBeCloseTo(70);
    expect(sampler(0.995)).toBeGreaterThan(7);
    expect(sampler(0.995)).toBeLessThan(70);
  });
});
