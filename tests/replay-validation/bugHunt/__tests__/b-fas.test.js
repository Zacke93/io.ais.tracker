'use strict';

/**
 * Rättningsrundan 2026-11-04, rättare B: M-FAS-jämförelsens parning och
 * drift (motorgranskningens M06 och M07). Rena funktioner på små
 * replayresultat; inga barnprocesser och inga timers.
 */

const relations = require('../lib/relations');
const project = require('../lib/project');
const { loadRegistry } = require('../lib/registry');
const { makeFinding } = require('../lib/finding');

const T = 1783000000000; // 13:46:40
const H = 3600e3;
const notis = (t, direction = 'northbound') => ({
  mmsi: '265552100', bridge: 'Klaffbron', direction, t, success: true, eta: 3, message: 'x', source: 'target',
});
const passage = (t) => ({ mmsi: '265552100', bridge: 'Klaffbron', t });
const klasser = (diffs) => diffs.map((d) => d.klass);

describe('M06: tappad och tillagd paras bara inom PAIR_WINDOW_MS, och då närmaste i tid', () => {
  test('granskarens pairprobe: en tappad notis och en orelaterad notis 6 h senare är två fynd, inte ett riktningsbyte', () => {
    const variant = { notifications: [notis(T + 6 * H, 'unknown')] };
    const d = relations.notificationDiffs({ notifications: [notis(T)] }, variant, 0);
    expect(klasser(d)).toEqual(['NOTISNYCKEL TAPPAD', 'NOTISNYCKEL TILLAGD']);
    // Och inget av dem är DESIGN via D4 (som i granskarens sond).
    const reg = loadRegistry();
    for (const x of d) {
      const f = makeFinding({
        orakel: 'M-FAS',
        klass: x.klass,
        allvar: 4,
        mmsi: x.notis.mmsi,
        bro: x.notis.bridge,
        riktning: x.notis.direction,
        t: x.t,
        belägg: { notis: x.notis, par: x.par || null, nyRiktning: x.nyRiktning },
        spår: 'bank',
        nivå: 'bank',
      });
      expect(reg.classify(f, { rader: [], resultat: variant }, { räkna: false }).klass).toBe('KANDIDAT');
    }
  });

  test('ett byte paras med den närmaste tillagda notisen, och gränsen är 120 s', () => {
    const bas = { notifications: [notis(T)] };
    // Söderut 100 s efter och unknown 10 s efter: bytet är till unknown.
    const d = relations.notificationDiffs(bas, { notifications: [notis(T + 100000, 'southbound'), notis(T + 10000, 'unknown')] }, 0);
    expect(klasser(d)).toEqual(['NOTISRIKTNING BYTT', 'NOTISNYCKEL TILLAGD']);
    expect(d[0].nyRiktning).toBe('unknown');
    expect(d[1].notis.direction).toBe('southbound');
    // I basens tidsram: variantens tider minus δ.
    expect(klasser(relations.notificationDiffs(bas, { notifications: [notis(T + 7000 + 120000, 'unknown')] }, 7000))).toEqual(['NOTISRIKTNING BYTT']);
    expect(klasser(relations.notificationDiffs(bas, { notifications: [notis(T + 7000 + 120001, 'unknown')] }, 7000))).toEqual(['NOTISNYCKEL TAPPAD', 'NOTISNYCKEL TILLAGD']);
  });

  test('PASSAGETYP BYTT paras på samma sätt', () => {
    const bas = { targetPassages: [passage(T)] };
    expect(klasser(relations.passageDiffs(bas, { intermediatePassages: [passage(T + 6 * H)] }, 0))).toEqual(['PASSAGENYCKEL TAPPAD', 'PASSAGENYCKEL TILLAGD']);
    expect(klasser(relations.passageDiffs(bas, { intermediatePassages: [passage(T + 30000)] }, 0))).toEqual(['PASSAGETYP BYTT']);
    // Två kandidater i fönstret: den närmaste paras.
    const d = relations.passageDiffs(bas, { intermediatePassages: [passage(T + 110000), passage(T - 20000)] }, 0);
    expect(klasser(d)).toEqual(['PASSAGETYP BYTT', 'PASSAGENYCKEL TILLAGD']);
    expect(d[0].par.variant.t).toBe(T - 20000);
  });
});

describe('M07: driften räknas sedan de tappade och tillagda notiserna tagits bort', () => {
  test('granskarens driftprobe: en extra notis mitt i en nyckel ger TILLAGD men ingen drift', () => {
    const bas = { notifications: [notis(T), notis(T + 3 * H)] };
    const variant = { notifications: [notis(T), notis(T + H), notis(T + 3 * H)] };
    expect(relations.notificationDiffs(bas, variant, 0).map((d) => [d.klass, d.t])).toEqual([['NOTISNYCKEL TILLAGD', T + H]]);
    const drift = project.notificationDrift(bas, variant, { dt: 0 });
    expect(drift.maxDriftMs).toBe(0);
    expect(drift.perNyckel).toEqual([]);
  });

  test('de parade notiserna mäts fortfarande, och M-FAS ger ett drift- och ett tilläggsfynd på rätt notis', () => {
    const bas = { notifications: [notis(T), notis(T + 3 * H)], openingWarnings: [] };
    const variant = { notifications: [notis(T + 7000 + 40000), notis(T + 7000 + H), notis(T + 7000 + 3 * H)], openingWarnings: [] };
    const drift = project.notificationDrift(bas, variant, { dt: 7000 });
    expect(drift.perNyckel).toEqual([{ nyckel: '265552100:Klaffbron:northbound', driftMs: 40000, t: T }]);
    // Hela fasjämförelsen: TILLAGD 14:46:40 och drift 40 s för notisen 13:46:40, inget mer i M-FAS.
    const base = {
      korpus: { id: 'x', knownInvariantExceptions: [] },
      kc: {
        id: 'x', rader: [], simTimmar: 4, jsonl: '/finns/inte/bas.jsonl', statePath: null,
      },
      resultat: bas,
      gt: [],
      fatala: [],
      leverans: [],
    };
    const utfall = {
      ok: true, resultat: variant, stderr: { h3: {}, exempel: {} }, ms: 1,
    };
    const fynd = relations.comparePhase(base, utfall, {
      deltaS: 7, monitoring: false, fil: { jsonl: '/finns/inte/variant.jsonl', statePath: null }, h3Baslinje: { signaturer: {}, timmar: 4 },
    }).filter((f) => f.orakel === 'M-FAS');
    expect(fynd.map((f) => [f.klass, f.t])).toEqual([['NOTISNYCKEL TILLAGD', T + H], ['NOTISDRIFT>30s', T]]);
    expect(fynd[1].belägg.driftMs).toBe(40000);
  });
});
