'use strict';

/**
 * Fältfamiljerna och radiomodellen 'blandad' (BUGGJAKT §4.6, omgång 9).
 * Ren generering: inga barnprocesser, ingen replay och inga timers.
 *
 * (a) De gamla världarna är bitlika: radhashar för tio index (seed 1) är
 *     frysta från a0d8706, och profilerna utan fältet familjer drar ur
 *     FAMILIES som förut.
 * (b) Fältvärldarna: blandade källor, källbortfall, en enda fix, tystnad i
 *     kön och arbetsbåten, var och en prövad mot sin egen definition.
 * (c) Profilen falt och sanningsspårets flaggor.
 */

const geo = require('../lib/geo');
const { deepFreeze, hashRows } = require('../lib/rng');
const families = require('../lib/families');
const falt = require('../lib/faltFamiljer');
const core = require('../lib/synthCore');
const { simulateWorld, simulateBoat } = require('../lib/world');
const { observeWorld } = require('../lib/radio');
const profiles = require('../lib/profiles');
const lane = require('../lib/lanes/synth');

// Frysta på a0d8706 (wt-bas) med core.materialize(sampleWorld(1, i), {profile}).radHash.
const FRUSNA = [
  [0, 'b0d6b8b77b7c2875', 'fe88f56160646024'],
  [1, '8065379c37b964ac', '998e51ac7b4d0d90'],
  [2, 'f7e9be141acc5255', '0c9d01647b2fa8a4'],
  [3, '77d015e5e2916ae1', '5267431f07621d5c'],
  [7, 'e8290cc55823ffe1', 'b55cef588a67eed3'],
  [40, 'c7620995fe4c7ee6', '209e6b284ecb288a'],
  [290, '0164f5e855b5f880', '48e934b4c5e54d8d'],
  [625, '393af1d33f795ac0', '5e2a52682a8eef07'],
  [1527, 'd43d32e6cf556a4d', '137608d19f699732'],
  [1907, '5190795f983b4a82', '3c303fda7c44b396'],
];

const observe = (spec, profile) => observeWorld(simulateWorld(deepFreeze(JSON.parse(JSON.stringify(spec)))), { profile }).rows;
// Korta världar (2,5 h) håller sviten snabb; F-LÅGSÄSONG förlänger själv världen till lastfartygets behov.
const fältVärld = (familj, i) => families.sampleWorld(1, 100000 + i, { families: [familj], hours: 2.5 });

describe('(a) de gamla världarna är bitlika', () => {
  test('tio världar ger samma rader i R0 och R1 som på a0d8706', () => {
    for (const [i, r0, r1] of FRUSNA) {
      const spec = families.sampleWorld(1, i);
      expect([i, core.materialize(spec, { profile: 'R0' }).radHash.slice(0, 16)]).toEqual([i, r0]);
      expect([i, core.materialize(spec, { profile: 'R1' }).radHash.slice(0, 16)]).toEqual([i, r1]);
    }
  });

  test('FAMILIES är oförändrad och innehåller ingen fältfamilj', () => {
    expect(families.FAMILIES).toEqual(['F-TRANSIT', 'F-KONVOJ', 'F-MÖTE', 'F-KÖ', 'F-KRYP', 'F-USVÄNG', 'F-KAJ', 'F-SENFÖDD', 'F-AVBROTT']);
    for (const f of families.FÄLTFAMILJER) expect(families.FAMILIES).not.toContain(f);
  });

  test('de gamla profilerna har inga familjer och inget indexBas', () => {
    for (const p of ['quick', 'standard', 'night']) {
      expect(profiles.PROFILES[p].familjer).toBeUndefined();
      expect(profiles.PROFILES[p].indexBas).toBeUndefined();
      expect(lane.laneOptions({ profil: p }).families).toEqual(families.FAMILIES);
    }
  });
});

describe('(b) fältvärldarna', () => {
  test('alla fältvärldar har vinterdatum, radiomodellen blandad och båda källorna i R1', () => {
    for (const fam of families.FÄLTFAMILJER) {
      for (let i = 0; i < 3; i++) {
        const spec = fältVärld(fam, i);
        expect(spec.familj).toBe(fam);
        expect(spec.era).toBe('blandad');
        expect(new Date(spec.startMs).getUTCMonth()).toBe(10);
        const rows = observe(spec, 'R1');
        const feeds = new Set(rows.filter((r) => !r.ctrl).map((r) => r.feed));
        if (!(fam === 'F-KÄLLBORTFALL' && spec.fokal.parametrar.variant === 'aisstream-nere')) expect([...feeds].sort()).toEqual(['aishub', 'aisstream']);
        // R0 är fortfarande en enkällsradio: bara aisstream.
        expect(new Set(observe(spec, 'R0').filter((r) => !r.ctrl).map((r) => r.feed))).toEqual(new Set(['aisstream']));
      }
    }
  });

  test('källbortfallet tystar sin källa i fönstret, och AISHub-raderna är 0–70 s gamla', () => {
    let prövade = 0;
    for (let i = 0; i < 30 && prövade < 6; i++) {
      const spec = fältVärld('F-KÄLLBORTFALL', i);
      const [fel] = spec.källfel;
      const rows = observe(spec, 'R1').filter((r) => !r.ctrl);
      const iFönster = rows.filter((r) => r.feed === fel.källa
        && r.aisTimestamp >= spec.startMs + (fel.frånS * 1000) + 1000 && r.aisTimestamp < spec.startMs + (fel.tillS * 1000) - 1000);
      expect(iFönster).toEqual([]);
      for (const r of rows.filter((x) => x.feed === 'aishub')) {
        const ålder = (r.aisTimestamp - r.fixTs) / 1000;
        expect(ålder).toBeGreaterThanOrEqual(0);
        expect(ålder).toBeLessThan(71);
      }
      prövade++;
    }
    expect(prövade).toBe(6);
  });

  test('en båt i F-ENGÅNG hörs exakt en gång, i båda radioprofilerna, nära sin fixpunkt', () => {
    for (let i = 0; i < 6; i++) {
      const spec = fältVärld('F-ENGÅNG', i);
      const b = spec.boats.find((x) => x.enfix);
      for (const profile of ['R0', 'R1']) {
        const egna = observe(spec, profile).filter((r) => r.mmsi === b.mmsi);
        expect(egna).toHaveLength(1);
        const p = geo.project(egna[0].lat, egna[0].lon);
        expect(Math.abs(p.s - b.enfix.s)).toBeLessThan(60);
        // En båt som ska vända bromsar redan före fixen (432 m från 14 kn vid 0,06 m/s²).
        if (spec.fokal.parametrar.variant !== 'vänder') expect(egna[0].sog).toBeGreaterThanOrEqual(9.5);
      }
    }
  });

  test('den väntande båten i F-MÅLBROVÄNTAN sänder inget under sin tystnad, i båda profilerna', () => {
    let prövade = 0;
    for (let i = 0; i < 40 && prövade < 5; i++) {
      const spec = fältVärld('F-MÅLBROVÄNTAN', i);
      const a = spec.boats.find((x) => Array.isArray(x.tystnad));
      if (!a) continue;
      const [w] = a.tystnad;
      for (const profile of ['R0', 'R1']) {
        const egna = observe(spec, profile).filter((r) => r.mmsi === a.mmsi);
        expect(egna.filter((r) => r.fixTs >= spec.startMs + (w.frånS * 1000) && r.fixTs < spec.startMs + (w.tillS * 1000))).toEqual([]);
        expect(egna.length).toBeGreaterThan(5);
      }
      prövade++;
    }
    expect(prövade).toBe(5);
  });

  test('kön ligger vid målbron och den andra båten lämnar sin köplats efter den första', () => {
    let par = 0;
    for (let i = 0; i < 60 && par < 4; i++) {
      const spec = fältVärld('F-MÅLBROVÄNTAN', i);
      const [a, b] = spec.fokal.mmsis.map((m) => spec.boats.find((x) => x.mmsi === m));
      expect(geo.TARGETS).toContain(spec.fokal.parametrar.bro);
      expect(a.plan.some((x) => x.op === 'queue' && x.bridge === spec.fokal.parametrar.bro)).toBe(true);
      if (!b) continue;
      // Bara köstoppen vid målbron (inflygningsprofilen kan lägga stopp vid andra broar).
      const vidBron = (st) => st.kind === 'queue' && Math.abs(st.s - geo.stationByName[spec.fokal.parametrar.bro].s) < 500;
      const sa = simulateBoat(a).stops.filter(vidBron);
      const sb = simulateBoat(b).stops.filter(vidBron);
      expect(sb[0].t1).toBeGreaterThan(sa[sa.length - 1].t1);
      par++;
    }
    expect(par).toBe(4);
  });

  test('granskningen S1: tystnaden ligger i målbrons kö och den andra båten når kön medan den första väntar', () => {
    let tystnader = 0;
    let par = 0;
    for (let i = 0; i < 300; i++) {
      const spec = families.sampleWorld(1, 100000 + i, { families: families.FÄLTFAMILJER });
      if (spec.familj !== 'F-MÅLBROVÄNTAN') continue;
      const pr = spec.fokal.parametrar;
      const bs = geo.stationByName[pr.bro].s;
      const vid = (st) => st.kind === 'queue' && (st.s - bs) * (pr.riktning === 'south' ? 1 : -1) >= 0
        && (st.s - bs) * (pr.riktning === 'south' ? 1 : -1) <= 600;
      const [a, b] = spec.fokal.mmsis.map((m) => spec.boats.find((x) => x.mmsi === m));
      const köA = simulateBoat(a).stops.filter(vid);
      expect(köA.length).toBeGreaterThan(0);
      if (pr.tystnad !== 'ingen' && a.tystnad) {
        const [w] = a.tystnad;
        expect(w.tillS).toBeGreaterThan(w.frånS);
        expect(w.frånS).toBeGreaterThanOrEqual(köA[0].t0);
        expect(w.frånS).toBeLessThanOrEqual(köA[köA.length - 1].t1);
        tystnader++;
      }
      if (b) {
        const köB = simulateBoat(b).stops.filter(vid);
        expect(köB.length).toBeGreaterThan(0);
        expect(köB[0].t0).toBeLessThan(köA[köA.length - 1].t1);
        expect(Math.abs(köB[0].s - bs)).toBeLessThanOrEqual(pr.bro === 'Klaffbron' ? 411 : 321);
        par++;
      }
    }
    expect(tystnader).toBeGreaterThan(20);
    expect(par).toBeGreaterThan(10);
  });

  test('arbetsbåten flyttar sig längs kajen utan att korsa en brolinje och ligger annars still', () => {
    for (let i = 0; i < 10; i++) {
      const spec = fältVärld('F-LÅGSÄSONG', i);
      const arb = spec.boats.find((x) => x.role === 'arbetsbåt');
      const { traj, stops } = simulateBoat(arb);
      const sMin = Math.min(...traj.map((p) => p.s));
      const sMax = Math.max(...traj.map((p) => p.s));
      for (const st of geo.STATIONS) expect(st.s > sMin && st.s < sMax).toBe(false);
      // Flytten är en av bankens inspelade kajflyttar (± 10 m).
      const [första] = arb.flyttar;
      expect(falt.KAJFLYTTAR.some((k) => Math.abs(k.från - arb.sKaj) <= 10 && Math.abs(k.till - första.tillS) <= 10)).toBe(true);
      expect(traj.filter((p) => p.v !== 0).length).toBeGreaterThan(0);
      expect(stops.every((s) => s.kind === 'moor')).toBe(true);
      expect(traj[traj.length - 1].t - traj[0].t).toBe(arb.durS);
      // Lastfartyget kommer efter minst en timme tom kanal.
      const last = spec.boats.find((x) => (x.tags || []).includes('lastfartyg'));
      expect(last.tStartS).toBeGreaterThanOrEqual(3600);
      expect(last.cruiseKn).toBeGreaterThanOrEqual(6);
      expect(last.cruiseKn).toBeLessThanOrEqual(8);
    }
  });

  test('fusionens F6: ingen AISHub-rad är äldre än eller lika gammal som båtens senast levererade fix', () => {
    for (const fam of families.FÄLTFAMILJER) {
      for (let i = 0; i < 3; i++) {
        const senast = {};
        for (const r of observe(fältVärld(fam, i), 'R1')) {
          if (r.ctrl) continue;
          if (r.feed === 'aishub' && senast[r.mmsi] !== undefined) expect(r.fixTs).toBeGreaterThan(senast[r.mmsi]);
          senast[r.mmsi] = Math.max(senast[r.mmsi] || 0, r.fixTs);
        }
      }
    }
  });

  test('fältvärldarna är deterministiska ur sin JSON-spec (rundresan)', () => {
    for (const fam of families.FÄLTFAMILJER) {
      const spec = fältVärld(fam, 1);
      for (const profile of ['R0', 'R1']) {
        expect(hashRows(observe(spec, profile))).toBe(hashRows(observe(JSON.parse(JSON.stringify(spec)), profile)));
      }
    }
  });

  test('vinterkvantilerna är monotona', () => {
    for (const tab of [falt.VINTER.aisstream.transit, falt.VINTER.aisstream.stilla, falt.VINTER.aishub.transit,
      falt.VINTER.aishub.stilla, falt.VINTER.ålder.rörelse, falt.VINTER.ålder.stilla]) {
      const v = ['p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'p99'].map((k) => tab[k]);
      for (let k = 1; k < v.length; k++) expect(v[k]).toBeGreaterThanOrEqual(v[k - 1]);
    }
  });
});

describe('(d) profilen blandad: de gamla familjerna med inflygning och båda källorna', () => {
  test('samma båtar och familj som utan läget, men inflygning, blandad radio och aldrig kortare värld', () => {
    for (let i = 200000; i < 200004; i++) {
      const gammal = families.sampleWorld(1, i, { hours: 2.5 });
      const ny = families.sampleWorld(1, i, { hours: 2.5, families: families.FAMILIES, inflygning: true });
      expect(ny.familj).toBe(gammal.familj);
      expect(ny.boats.map((b) => b.mmsi)).toEqual(gammal.boats.map((b) => b.mmsi));
      expect(ny.boats.map((b) => b.tStartS)).toEqual(gammal.boats.map((b) => b.tStartS));
      expect(ny.era).toBe('blandad');
      expect(gammal.era).not.toBe('blandad');
      expect(ny.durS).toBeGreaterThanOrEqual(gammal.durS);
      expect(ny.boats.filter((b) => b.role === 'transit').every((b) => (b.tags || []).includes('inflygning'))).toBe(true);
      const feeds = new Set(observe(ny, 'R1').filter((r) => !r.ctrl).map((r) => r.feed));
      expect([...feeds].sort()).toEqual(['aishub', 'aisstream']);
    }
  });

  test('profilen blandad har egna index och drar ur FAMILIES', () => {
    const p = profiles.getProfile('blandad');
    expect(p.indexBas).toBe(200000);
    expect(p.inflygning).toBe(true);
    expect([...p.familjer]).toEqual(families.FAMILIES);
    expect(lane.laneOptions({ profil: 'blandad' }).families).toEqual(families.FAMILIES);
  });
});

describe('(c) profilen falt och flaggorna', () => {
  test('profilen falt drar ur fältfamiljerna från index 100 000', () => {
    const p = profiles.getProfile('falt');
    expect([...p.familjer]).toEqual(families.FÄLTFAMILJER);
    expect(p.indexBas).toBe(100000);
    expect(lane.laneOptions({ profil: 'falt' }).families).toEqual(families.FÄLTFAMILJER);
    expect(lane.laneOptions({ profil: 'falt', familjer: ['F-KÖ'] }).families).toEqual(['F-KÖ']);
  });

  test('--families godtar fältfamiljerna och vägrar okända', () => {
    expect(() => lane.kontrollera({ familjer: ['F-ENGÅNG', 'F-KÖ'] })).not.toThrow();
    expect(() => lane.kontrollera({ familjer: ['F-VINTER'] })).toThrow(/okänd familj/);
  });
});
