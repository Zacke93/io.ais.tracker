'use strict';

/**
 * Buggjägaren steg 8: världsmodell, familjer, radio och sanning L0/L1.
 * Ren generering — inga barnprocesser, ingen replay och inga timers.
 */

const fs = require('fs');
const path = require('path');
const geo = require('../lib/geo');
const { deepFreeze, hashRows } = require('../lib/rng');
const families = require('../lib/families');
const { simulateWorld, simulateBoat, KN } = require('../lib/world');
const { observeWorld, checkRows, silenceWindows } = require('../lib/radio');
const truth = require('../lib/truth');

// Om ramverkets schema.js finns i samma träd prövas raderna även mot den
// (sökvägen byggs dynamiskt: filen kommer från ramverksbygget).
let schemaValidate = null;
const SCHEMA_FILE = path.join(__dirname, '..', 'lib', 'schema.js');
if (fs.existsSync(SCHEMA_FILE)) {
  // eslint-disable-next-line global-require
  const schema = require(SCHEMA_FILE);
  if (schema && typeof schema.validateRows === 'function') schemaValidate = schema.validateRows;
}

const N = 20;
const SEED = 4711;
const HOURS = 2; // korta världar håller sviten under budget (jest kör genereringen ~4× långsammare)
const specs = Array.from({ length: N }, (_, i) => families.sampleWorld(SEED, i, { hours: HOURS }));
// Fylls av (a) och återanvänds av (b) och (e): {R0: {rows, realisation}, R1: …} per värld.
const observed = [];

describe('världar på djupfryst spec', () => {
  test('(a) 20 världar simuleras och observeras på djupfryst spec utan kast', () => {
    for (const spec of specs) {
      const frozen = deepFreeze(spec);
      const sim = simulateWorld(frozen);
      const o = {};
      for (const profile of ['R0', 'R1']) {
        o[profile] = observeWorld(sim, { profile });
        expect(o[profile].rows.length).toBeGreaterThan(0);
      }
      observed.push(o);
      expect(Object.isFrozen(frozen.boats[0])).toBe(true);
    }
  });

  test('(b) omsimulering ur JSON.parse(JSON.stringify(spec)) ger identisk radhash (båda profilerna)', () => {
    specs.forEach((spec, i) => {
      const sim = simulateWorld(deepFreeze(JSON.parse(JSON.stringify(spec))));
      for (const profile of ['R0', 'R1']) {
        const again = observeWorld(sim, { profile });
        expect(hashRows(again.rows)).toBe(hashRows(observed[i][profile].rows));
        expect(again.realisation).toEqual(observed[i][profile].realisation);
      }
    });
    // Samma bas-seed och index ger samma spec oavsett körningens storlek.
    expect(families.sampleWorld(SEED, 7, { hours: HOURS })).toEqual(JSON.parse(JSON.stringify(specs[7])));
  });

  test('specen innehåller inga Infinity, NaN eller undefined', () => {
    for (const spec of specs) {
      const walk = (v) => {
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
        else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
        expect(v).not.toBeUndefined();
      };
      walk(spec);
      expect(families.FAMILIES).toContain(spec.familj);
    }
  });
});

describe('L0', () => {
  test('(c) korsningen för en båt i konstant fart ligger inom 1 s från den analytiska', () => {
    // Krypplanen håller 1 kn ända fram till Klaffbron (lägre än alla sektorfarter).
    const boat = {
      mmsi: '265000777',
      name: 'KONSTANT',
      cls: 'A',
      role: 'transit',
      dir: 'north',
      tStartS: 100,
      sStart: -350,
      sEnd: 7150,
      cruiseKn: 5,
      v0Kn: 1,
      laneM: 0,
      queueLaneM: 0,
      lateralSigma: 0,
      plan: [{
        op: 'crawl', bridge: 'Klaffbron', withinM: 99999, kn: 1,
      }],
      tags: [],
      seed: 1,
    };
    const spec = deepFreeze({
      version: 1, seed: 1, startMs: Date.UTC(2026, 6, 1, 8, 0, 0), durS: 4 * 3600, era: 'aisstream', boats: [boat], events: [], radioSeed: 1,
    });
    const L0 = truth.deriveTruth(simulateWorld(spec));
    const c = L0.crossings.find((x) => x.bridge === 'Klaffbron');
    const analytic = spec.startMs + ((100 + ((geo.stationByName.Klaffbron.s + 350) / (1 * KN))) * 1000);
    expect(Math.abs(c.t - analytic)).toBeLessThan(1000);
    expect(c.dir).toBe('nord');
    // Alla fem stationer korsas norrut, i ordning.
    expect(L0.crossings.map((x) => x.bridge)).toEqual(geo.STATIONS.map((x) => x.name));
  });

  test('U-svängen bokförs och ger korsningar åt båda håll', () => {
    const b = families.sampleWorld(SEED, 0, { family: 'F-USVÄNG', hours: HOURS }).boats.find((x) => x.fokal);
    const sim = simulateBoat(b);
    expect(sim.uturns).toHaveLength(1);
    const dirs = new Set(sim.traj.filter((p) => Math.abs(p.v) > 0.25).map((p) => Math.sign(p.v)));
    expect(dirs.size).toBe(2);
  });

  test('(g) en konstruerad kedja med sex båtar märks stress, fem glesa båtar gör det inte', () => {
    const mk = (n, gapS) => {
      const spec = families.canarySpec({
        id: 'kedja', dir: 'north', kn: 5, cls: 'A', intervalS: 30,
      });
      const base = spec.boats[0];
      return deepFreeze({
        ...spec,
        boats: Array.from({ length: n }, (_, i) => ({ ...base, mmsi: String(265900500 + i), tStartS: 60 + (i * gapS) })),
      });
    };
    expect(truth.densityLevel(truth.deriveTruth(simulateWorld(mk(6, 300))))['nivå']).toBe('stress');
    const sparse = truth.densityLevel(truth.deriveTruth(simulateWorld(mk(5, 300))));
    expect(sparse['nivå']).toBe('realistisk');
    expect(sparse['längstaKedja']).toBe(5);
  });
});

describe('L1', () => {
  // En båt norrut genom Klaffbron: fixar 30 s isär på båda sidor.
  const sB = geo.stationByName.Klaffbron.s;
  const t0 = Date.UTC(2026, 6, 1, 8, 0, 0);
  const v = 2.5; // m/s
  const tCross = t0 + (600 * 1000);
  const fixAt = (dtS) => {
    const p = geo.pointAt(sB + (v * dtS), 0);
    const t = tCross + (dtS * 1000);
    return {
      mmsi: '265000888', msgType: 'PositionReport', lat: p.lat, lon: p.lon, sog: 4.9, cog: 30, aisTimestamp: t, fixTs: t, feed: 'aisstream',
    };
  };
  const L0 = {
    crossings: [{
      mmsi: '265000888', bridge: 'Klaffbron', t: tCross, dir: 'nord',
    }],
  };

  test('(d) korsningen är punktobserverbar med fixar på båda sidor', () => {
    const rows = [-90, -60, -30, 30, 60, 90].map(fixAt);
    const L1 = truth.deriveObservable(L0, rows);
    expect(L1.crossings).toHaveLength(1);
    expect(L1.crossings[0].inferred).toBe(false);
    expect(L1.crossings[0].tObs).toBe(tCross + 30000);
    const gtRows = truth.asGt(L1.crossings, { targetsOnly: true, pointOnly: true });
    expect(gtRows[0].tFrom).toBe(tCross);
    expect(gtRows[0].tTo).toBe(tCross);
  });

  test('(d) korsningen försvinner utan fixar på ena sidan och blir inferred vid 1000 s glapp', () => {
    expect(truth.deriveObservable(L0, [-90, -60, -30].map(fixAt)).crossings).toHaveLength(0);
    expect(truth.deriveObservable(L0, [30, 60].map(fixAt)).crossings).toHaveLength(0);
    const L1 = truth.deriveObservable(L0, [-600, 400].map(fixAt));
    expect(L1.crossings).toHaveLength(1);
    expect(L1.crossings[0].inferred).toBe(true);
    expect(L1.crossings[0].gapS).toBe(1000);
    expect(truth.asGt(L1.crossings, { pointOnly: true })).toHaveLength(0);
  });

  test('varje fix bär närmaste notispunkt', () => {
    const L1 = truth.deriveObservable(L0, [-30, 30].map(fixAt));
    for (const list of L1.fixes.values()) for (const f of list) expect(f.nearest).toBe('Klaffbron');
  });
});

describe('radio', () => {
  test('(e) alla genererade rader klarar radkontrollen (och schema.validateRows om den finns)', () => {
    const problems = [];
    for (const o of observed) {
      for (const profile of ['R0', 'R1']) {
        const { rows } = o[profile];
        expect(() => checkRows(rows)).not.toThrow();
        // Oberoende kontroll med vanlig JS (ett expect per rad vore för långsamt i jest).
        rows.forEach((r, i) => {
          if (!Number.isFinite(r.aisTimestamp)) problems.push(`${profile} rad ${i + 1}: aisTimestamp`);
          if ('timestamp' in r || 'fixFeed' in r) problems.push(`${profile} rad ${i + 1}: förbjudet fältnamn`);
          if (!r.ctrl && (!/^\d{9}$/.test(r.mmsi) || !(r.fixTs <= r.aisTimestamp))) problems.push(`${profile} rad ${i + 1}: mmsi/fixTs`);
          if (i > 0 && r.aisTimestamp < rows[i - 1].aisTimestamp) problems.push(`${profile} rad ${i + 1}: osorterad`);
        });
        if (schemaValidate) {
          const res = schemaValidate(rows);
          if (Array.isArray(res)) expect(res).toEqual([]);
          else if (res && typeof res === 'object' && 'ok' in res) expect(res.ok).toBe(true);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('radkontrollen avvisar sekunder, ISO-sträng, fixTs > aisTimestamp, okänd ctrl och förbjudna fältnamn', () => {
    const ok = {
      mmsi: '265000001', lat: 58.28, lon: 12.28, aisTimestamp: 1.78e12, fixTs: 1.78e12, feed: 'aisstream',
    };
    expect(() => checkRows([ok, { ctrl: 'restart', aisTimestamp: 1.78e12 }])).not.toThrow();
    expect(() => checkRows([{ ...ok, aisTimestamp: 1.78e9 }])).toThrow(/rad 1/);
    expect(() => checkRows([ok, { ...ok, aisTimestamp: '2026-07-01T08:00:00Z' }])).toThrow(/rad 2/);
    expect(() => checkRows([{ ...ok, fixTs: ok.aisTimestamp + 1 }])).toThrow(/fixTs/);
    expect(() => checkRows([{ ctrl: 'boom', aisTimestamp: 1.78e12 }])).toThrow(/ctrl/);
    expect(() => checkRows([{ ctrl: 'restart' }])).toThrow(/aisTimestamp/);
    expect(() => checkRows([{ ...ok, timestamp: 1 }])).toThrow(/förbjudet/);
    expect(() => checkRows([{ ...ok, mmsi: 265000001 }])).toThrow(/mmsi/);
  });

  test('(f) inga positionsrader i avbrottsfönster, och ctrl-raderna har epok-ms', () => {
    let windows = 0;
    for (let i = 0; i < 4; i++) {
      const spec = families.sampleWorld(SEED, 100 + i, { family: 'F-AVBROTT', hours: HOURS });
      const sim = simulateWorld(spec);
      const sil = silenceWindows(spec);
      expect(sil.length).toBe(1);
      windows += sil.length;
      for (const profile of ['R0', 'R1']) {
        const { rows } = observeWorld(sim, { profile });
        const ctrl = rows.filter((r) => r.ctrl);
        expect(ctrl.map((r) => r.ctrl)).toEqual(['disconnect', 'reconnect']);
        const [a, z] = [ctrl[0].aisTimestamp, ctrl[1].aisTimestamp];
        expect(a).toBeGreaterThan(1.5e12);
        expect(rows.filter((r) => !r.ctrl && r.aisTimestamp >= a && r.aisTimestamp < z)).toHaveLength(0);
      }
    }
    expect(windows).toBe(4);
  });

  test('R0 är idealradio: 30 s, klass A, aisstream, inga namnglapp', () => {
    const { rows, realisation } = observed[0].R0;
    const pos = rows.filter((r) => !r.ctrl);
    expect(new Set(pos.map((r) => r.feed))).toEqual(new Set(['aisstream']));
    expect(pos.every((r) => r.msgType === 'PositionReport')).toBe(true);
    expect(pos.every((r) => r.shipName !== 'Unknown')).toBe(true);
    expect(realisation).toEqual({});
    const one = pos.filter((r) => r.mmsi === pos[0].mmsi);
    const gaps = one.slice(1).map((r, k) => Math.round((r.aisTimestamp - one[k].aisTimestamp) / 1000));
    expect(gaps.every((g) => g === 30 || g > 30)).toBe(true);
    expect(gaps.filter((g) => g === 30).length).toBeGreaterThan(gaps.length * 0.9);
  });

  test('borttagen båt ändrar inte de andra båtarnas observationer (egen radioström per båt)', () => {
    const k = Math.max(0, specs.findIndex((s) => s.boats.length >= 3 && s.era === 'aisstream'));
    const spec = specs[k];
    const full = observed[k].R1.rows;
    const drop = spec.boats[spec.boats.length - 1].mmsi;
    const less = observeWorld(simulateWorld({ ...spec, boats: spec.boats.slice(0, -1) }), { profile: 'R1' }).rows;
    expect(hashRows(less.filter((r) => r.mmsi !== drop))).toBe(hashRows(full.filter((r) => r.mmsi !== drop)));
  });
});
