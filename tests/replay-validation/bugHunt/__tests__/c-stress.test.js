'use strict';

/**
 * Rättningsrundan 2026-11-04, M10: sanningsspårets fynd ur världar med
 * uppmätt stresstäthet bildar egna kluster (`|stress` i nyckeln) med
 * nivåvikt 0,3 (BUGGJAKT §4.4 och §9), räknas aldrig som enheter i ett R0-
 * eller R1-kluster och redovisas i rapportens sektion Stress. Rena
 * funktioner — inga barnprocesser, inga timers.
 */

const T0 = Date.parse('2026-07-10T14:04:30.000Z');

function syntfynd(nivå, värld, overrides = {}) {
  const { makeFinding } = require('../lib/finding');
  return makeFinding({
    orakel: 'T2',
    klass: 'LEDTID<60s',
    allvar: 5,
    mmsi: '265591718',
    bro: 'Stridsbergsbron',
    riktning: 'southbound',
    t: T0 + (värld * 1000),
    detalj: `varning bara 55 s före sann korsning (värld ${värld})`,
    spår: 'synth',
    nivå,
    ursprung: {
      värld, radio: nivå === 'stress' ? 'R1' : nivå, familj: 'F-KONVOJ', båtar: 2, timmar: 1,
    },
    register: { klass: 'KANDIDAT', post: null, närmast: null },
    ...overrides,
  });
}

function körningMed(fynd) {
  const { clusterFindings } = require('../lib/cluster');
  const { loadRegistry } = require('../lib/registry');
  const { getProfile } = require('../lib/profiles');
  return {
    motorversion: 'test',
    git: {
      före: {
        finns: false, sha: null, sha7: 'nogit', ändrat: null,
      },
    },
    profil: getProfile('quick'),
    seed: 1,
    spår: ['synth'],
    korpusar: [],
    körningsId: 'abc',
    hälsa: { självtest: { status: 'EJ KÖRT', text: '' } },
    sammanfattning: [],
    fynd,
    kluster: clusterFindings(fynd),
    register: loadRegistry(),
    täckning: {
      rader: [],
      synt: {
        världar: 4, budget: 4, perProfil: { R0: 2, R1: 2 }, perNivå: { R0: 2, R1: 1, stress: 1 }, simTimmar: 4,
      },
    },
    tid: {},
  };
}

describe('M10: stressvärldarnas fynd', () => {
  test('bildar egna kluster med nivåvikt 0,3 och räknas inte som enheter i R0- eller R1-kluster', () => {
    const { clusterFindings } = require('../lib/cluster');
    const cl = clusterFindings([syntfynd('R0', 1), syntfynd('R0', 2), syntfynd('stress', 3), syntfynd('R1', 4), syntfynd('stress', 5)]);
    expect(cl.map((c) => c.nyckel).sort()).toEqual([
      'KANDIDAT|-|T2|LEDTID<Ns|synt',
      'KANDIDAT|-|T2|LEDTID<Ns|synt|stress',
    ]);
    const vanligt = cl.find((c) => c.nyckel.endsWith('|synt'));
    const stress = cl.find((c) => c.nyckel.endsWith('|stress'));
    expect(vanligt.nivå).toBe('R0');
    expect(vanligt.oberoende).toBe(3);
    expect(vanligt.fynd.every((f) => f.nivå !== 'stress')).toBe(true);
    expect(vanligt.poäng).toBeCloseTo(5 * 1.0 * (1 + Math.log2(3)), 2); // poängen avrundas till tre decimaler
    expect(stress.nivå).toBe('stress');
    expect(stress.oberoende).toBe(2);
    expect(stress.poäng).toBeCloseTo(5 * 0.3 * 2, 6);
    // Bankens och självtestets fynd påverkas inte (ingen nivå 'stress' där).
    const { clusterKey } = require('../lib/cluster');
    expect(clusterKey(syntfynd('stress', 6, { spår: 'bank' }))).toBe('KANDIDAT|-|T2|LEDTID<Ns');
  });

  test('rapporten får sektionen Stress och sammanfattningens "stress N" stämmer', () => {
    const report = require('../lib/report');
    const synth = require('../lib/lanes/synth');
    const k = körningMed([syntfynd('R0', 1), syntfynd('R1', 2), syntfynd('stress', 3)]);
    const urval = report.assignCards(k.kluster);
    expect(urval.kort).toHaveLength(2);
    const md = report.renderReportMd(k, urval);
    expect(md).toMatch(/### Stress \(täthet över fältets svans\)\n\n### F02 · KANDIDAT · stress · allvar 5 — /);
    expect(md.indexOf('### Logikfel (R0')).toBeLessThan(md.indexOf('### Stress'));
    const rad = synth.sammanfattning(k);
    expect(rad).toMatch(/→ 2 kandidatkluster \(logikfel R0 1, robusthet R1 0, stress 1\)/);
  });

  test('ett registerklassat stresskluster märks (stress) i kända utfall', () => {
    const report = require('../lib/report');
    const reg = { klass: 'KÄND_ÖPPEN', post: 'U2-VS-DEADLINE', närmast: null };
    const k = körningMed([syntfynd('R0', 1, { register: reg }), syntfynd('stress', 2, { register: reg })]);
    expect(k.kluster).toHaveLength(2);
    const md = report.renderReportMd(k, report.assignCards(k.kluster));
    expect(md).toMatch(/\| U2-VS-DEADLINE \| KÄND_ÖPPEN \| T2\\\|LEDTID<Ns \| 1 \|/);
    expect(md).toMatch(/\| U2-VS-DEADLINE \| KÄND_ÖPPEN \| T2\\\|LEDTID<Ns \(stress\) \| 1 \|/);
    expect(md).toMatch(/### U2-VS-DEADLINE · KÄND_ÖPPEN · stress — /);
  });
});
