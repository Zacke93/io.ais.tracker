'use strict';

/**
 * Buggjägaren steg 10: krympning och bekräftelse. Inga barnprocesser och
 * inga timers — proven är injicerade leksakspredikat, så sviten prövar
 * krympningens och bekräftelsens logik, inte appen.
 */

const shrink = require('../lib/shrink');
const confirm = require('../lib/confirm');
const core = require('../lib/synthCore');
const lane = require('../lib/lanes/synth');
const { canarySpec } = require('../lib/families');

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe('buggjägaren: krympning (steg 10)', () => {
  test('ddmin ger den minimala mängden {3, 7} ur 1…16, och samma svar två gånger', async () => {
    const run = async () => {
      let prov = 0;
      const res = await shrink.ddmin(range(16), async (s) => {
        prov++;
        return s.includes(3) && s.includes(7);
      });
      return { mängd: res.mängd, prov };
    };
    const a = await run();
    const b = await run();
    expect(a.mängd).toEqual([3, 7]);
    expect(b).toEqual(a);
  });

  test('ddmin skyddar den skyldiga och prövar aldrig den tomma mängden', async () => {
    const seen = [];
    const res = await shrink.ddmin(range(8), async (s) => {
      seen.push(s.length);
      return s.includes(5);
    }, { skyddade: [5] });
    expect(res.mängd).toEqual([5]);
    expect(seen).not.toContain(0);
  });

  test('budgeten stoppar ddmin och märker resultatet delvis', async () => {
    const budget = shrink.makeBudget({ maxProv: 2 });
    const res = await shrink.ddmin(range(16), async (s) => {
      budget.prov++;
      return s.includes(3) && s.includes(7);
    }, { budget });
    expect(res.delvis).toBe(true);
    expect(budget.skäl()).toMatch(/2 prov/);
  });

  test('annoteringen väljer CONVOY_WINDOW_MS för gränsen 618–678 s och besöksutfärden 350 m för en gräns vid 360 m', () => {
    const konvoj = shrink.annotateConstant({ värden: [618, 678], enhet: 's', familj: 'F-KONVOJ' });
    expect(konvoj).toMatchObject({ namn: 'CONVOY_WINDOW_MS', värde: 600, enhet: 's' });
    const usväng = shrink.annotateConstant({ värden: [360], enhet: 'm', familj: 'F-USVÄNG' });
    expect(usväng.namn).toMatch(/besöksutfärd/);
    expect(usväng.värde).toBe(350);
    expect(shrink.annotateConstant({ värden: [2000], enhet: 's', familj: 'F-KONVOJ' })).toBeNull();
  });

  test('gränssökningen hittar ett smalt felområde med högst 7 prov och annoterar konstanten', async () => {
    const spec = { familj: 'F-KONVOJ', x: 640 };
    const param = {
      namn: 'deltaS',
      enhet: 's',
      min: 30,
      max: 1200,
      decimaler: 0,
      get: (s) => s.x,
      set: (s, v) => {
        s.x = v;
      },
      familj: 'F-KONVOJ',
    };
    let prov = 0;
    const g = await shrink.searchParam(spec, param, async (s) => {
      prov++;
      return { holds: s.x >= 618 && s.x <= 678 };
    }, shrink.makeBudget());
    expect(prov).toBeLessThanOrEqual(shrink.MAX_PROV_PER_PARAMETER);
    expect(g.gränsHittad).toBe(true);
    expect(g.okNedanför).toBeLessThan(618);
    expect(g.okOvanför).toBeGreaterThan(678);
    expect(g.konstant.namn).toBe('CONVOY_WINDOW_MS');
    expect(shrink.boundaryText(g)).toMatch(/^fel (när|vid) deltaS .*Närmaste konstant: CONVOY_WINDOW_MS = 600 s\.$/);
  });

  test('krympningen på en leksaksspec: tidsfokus, skyldig båt och förenkling, deterministiskt', async () => {
    const base = canarySpec({
      id: 'T', dir: 'north', kn: 5, cls: 'B', intervalS: 30, pairGapS: 180,
    });
    const spec = JSON.parse(JSON.stringify(base));
    spec.familj = 'F-TRANSIT';
    spec.boats[1].plan = [{
      op: 'crawl', bridge: 'Klaffbron', withinM: 200, kn: 1,
    }];
    spec.events = [{ ctrl: 'disconnect', atS: 900 }, { ctrl: 'reconnect', atS: 960 }];
    const culprit = spec.boats[0].mmsi;
    // Leksakspredikatet: utslaget kräver bara den skyldiga båten.
    const holds = async (s) => s.boats.some((b) => b.mmsi === culprit);
    const run = () => shrink.shrinkSpec(spec, {
      mmsi: culprit, mmsis: [culprit], bro: 'Klaffbron', t: spec.startMs + 1800000,
    }, {
      holds, budget: shrink.makeBudget(), radio: 'R1',
    });
    const a = await run();
    const b = await run();
    expect(a.spec.boats.map((x) => x.mmsi)).toEqual([culprit]);
    expect(a.spec.events).toEqual([]);
    expect(a.spec.boats[0].cls).toBe('A');
    expect(a.spec.boats[0].fixedIntervalS).toBe(60);
    expect(a.steg.length).toBeGreaterThanOrEqual(3);
    expect(b).toEqual(a);
    // Specen ändras aldrig på plats.
    expect(spec.boats).toHaveLength(2);
  });
});

describe('buggjägaren: bekräftelse (steg 10)', () => {
  const res = (t0, extra = {}) => ({
    jsonl: 'x.jsonl',
    notifications: [{
      mmsi: '265000001', bridge: 'Klaffbron', direction: 'northbound', eta: 3, alreadyPassed: false, success: true, message: 'm', t: t0,
    }],
    openingWarnings: [],
    targetPassages: [{ mmsi: '265000001', bridge: 'Klaffbron', t: t0 + 60000 }],
    intermediatePassages: [],
    bridgeTextTransitions: [{ t: t0, text: 'En båt' }],
    leakDiagnostics: { heapUsedMB: 12, vessels: 0 },
    processErrors: 0,
    ...extra,
  });
  const T0 = Date.parse('2026-07-01T10:00:00.000Z');
  const fakeProbe = ({ shiftBreaks = false, gone7 = false, r0 = true } = {}) => async (spec, { radio }) => {
    const dt = spec.startMs - 1000;
    const shifted = dt === 30000 && shiftBreaks ? { processErrors: 1 } : {};
    const fynd = [];
    const has = !(dt === 7000 && gone7) && !(radio === 'R0' && !r0);
    if (has) fynd.push({ träff: true });
    return {
      built: { radHash: 'h' },
      utfall: { ok: true, resultat: res(T0 + dt, shifted) },
      fynd,
    };
  };
  const base = async (probe, radio = 'R1') => {
    const spec = { startMs: 1000 };
    const final = await probe(spec, { radio });
    return confirm.confirmRepro({
      spec, radio, probe, holds: (fynd) => fynd.some((f) => f.träff), final, rehash: () => 'h',
    });
  };

  test('deterministisk, +30 s identisk, +7 s kvar och R0 reproducerar ⇒ logikfel', async () => {
    const r = await base(fakeProbe());
    expect(r.instrumentfel).toBeNull();
    expect(r.knivsegg).toBe(false);
    expect(r.r0Bekräftad).toBe(true);
    expect(r.text).toBe('deterministisk · +30 s identisk · +7 s kvar · R1 → R0: reproducerar (logikfel)');
  });

  test('försvinner vid +7 s ⇒ KNIVSEGG; R0 utan utslaget ⇒ robusthet', async () => {
    const r = await base(fakeProbe({ gone7: true, r0: false }));
    expect(r.knivsegg).toBe(true);
    expect(r.r0Bekräftad).toBe(false);
    expect(r.text).toMatch(/\+7 s borta \(KNIVSEGG\).*reproducerar inte \(robusthet\)/);
  });

  test('ett annat utfall vid +30 s ⇒ INSTRUMENTFEL', async () => {
    const r = await base(fakeProbe({ shiftBreaks: true }));
    expect(r.instrumentfel).toMatch(/^SHIFT30/);
  });

  test('en ny radhash ur sparad spec ⇒ INSTRUMENTFEL (H5)', async () => {
    const probe = fakeProbe();
    const spec = { startMs: 1000 };
    const final = await probe(spec, { radio: 'R0' });
    const r = await confirm.confirmRepro({
      spec, radio: 'R0', probe, holds: (fynd) => fynd.length > 0, final, rehash: () => 'annan',
    });
    expect(r.instrumentfel).toMatch(/^H5/);
  });
});

describe('buggjägaren: sanningsspårets koppling', () => {
  test('registeralias: T1-beläggens ISO-tider blir epok-ms för registrets predikat', () => {
    const b = core.registryAliases({
      orakel: 'T1',
      riktning: 'northbound',
      belägg: {
        besök: { tIn: '2026-07-01T10:00:00.000Z', tOut: '2026-07-01T10:05:00.000Z' }, förstaFix: { t: '2026-07-01T10:01:00.000Z' }, korsning: { t: '2026-07-01T10:02:00.000Z', dir: 'nord' },
      },
    });
    expect(b.tIn).toBe(Date.parse('2026-07-01T10:00:00.000Z'));
    expect(b.tFörstaFix).toBe(Date.parse('2026-07-01T10:01:00.000Z'));
    expect(b.korsningT).toBe(Date.parse('2026-07-01T10:02:00.000Z'));
    expect(b.förväntadRiktning).toBe('northbound');
  });

  test('målet kräver mekanism, bro, inblandat mmsi och samma registerutfall', () => {
    const f = {
      orakel: 'T2', klass: 'LEDTID<60s', bro: 'Stridsbergsbron', mmsi: '265000002', belägg: { varning: { mmsis: ['265000002'] } }, register: { klass: 'KANDIDAT', post: null },
    };
    const mål = core.targetOf(f);
    expect(core.matchesTarget({ ...f, klass: 'LEDTID<55s' }, mål)).toBe(true);
    expect(core.matchesTarget({ ...f, bro: 'Klaffbron' }, mål)).toBe(false);
    expect(core.matchesTarget({ ...f, mmsi: '265000009', belägg: {} }, mål)).toBe(false);
    expect(core.matchesTarget({ ...f, register: { klass: 'KÄND_ÖPPEN', post: 'U2-VS-DEADLINE' } }, mål)).toBe(false);
  });

  test('syntetiska fynd klustras för sig, skilda från bankens fynd av samma mekanism', () => {
    const { clusterKey } = require('../lib/cluster');
    const f = {
      orakel: 'INV-F', klass: 'INV-3 ETA-SÅGTAND UPP', register: { klass: 'KANDIDAT', post: null },
    };
    expect(clusterKey({ ...f, spår: 'bank' })).toBe('KANDIDAT|-|INV-F|INV-3 ETA-SÅGTAND UPP');
    expect(clusterKey({ ...f, spår: 'synth' })).toBe('KANDIDAT|-|INV-F|INV-3 ETA-SÅGTAND UPP|synt');
  });

  test('--radio och --families kontrolleras innan något körs', () => {
    expect(() => lane.kontrollera({ radio: ['R0'], familjer: ['F-KÖ'] })).not.toThrow();
    expect(() => lane.kontrollera({ radio: ['R2'] })).toThrow(/v1\.1/);
    expect(() => lane.kontrollera({ familjer: ['F-OMSTART'] })).toThrow(/S1/);
    expect(() => lane.kontrollera({ familjer: ['F-OKÄND'] })).toThrow(/okänd familj/);
  });

  test('bekräftelsen flyttar ett R0-bekräftat R1-kluster till logikfel och räknar om poängen', () => {
    const f = { taggar: [], bekräftelse: { instrumentfel: null, knivsegg: false, r0Bekräftad: true } };
    const c = {
      nivå: 'R1', allvar: 5, oberoende: 1, knivsegg: false, poäng: 3, representanter: [f],
    };
    lane.applyConfirmation(c);
    expect(c.nivå).toBe('R0');
    expect(c.poäng).toBe(5);
    expect(f.taggar).toContain('R0-BEKRÄFTAD');
    const g = { taggar: [], bekräftelse: { instrumentfel: 'H5: x', knivsegg: false, r0Bekräftad: false } };
    const d = {
      nivå: 'R1', allvar: 5, oberoende: 1, registerklass: 'KANDIDAT', representanter: [g],
    };
    lane.applyConfirmation(d);
    expect(d.registerklass).toBe('INSTRUMENTFEL');
  });
});
