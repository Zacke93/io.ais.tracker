'use strict';

/**
 * Rättningsrunda 2, punkt E8 (rättare G): rapporten länkar tvillingkort.
 *
 * Triagen av standardrapporten fann kortpar utan länk: samma apphändelse i
 * två orakel (F12 INV-13 och F16 T10 FANTOMPASSAGE i värld 254 med samma
 * minsta repro; F18 och F19, INV-3 OSCILLATION och SÅGTAND UPP, med
 * byte-identiska repro.jsonl) och stresstvillingar (F20↔F03, F23↔F11,
 * F22↔F02, F21↔F13, F17↔F01). Korten slås inte ihop (klustringen per
 * mekanism är avsiktlig, BUGGJAKT §8) men länkas åt båda hållen i rapport.md
 * och rapport.json (§9):
 *   - "Samma minsta repro som Fxx (troligen samma apphändelse)" när två
 *     representanter har samma radhash (och monitoringläge);
 *   - "Samma utslag som Fxx i N världar (troligen samma apphändelse där)"
 *     när klustren delar ett utslag: samma värld eller korpus, bro och
 *     fartyg med överlappande utslagsfönster (prövad utvidgning av "samma
 *     representantvärld och överlappande utslagstid");
 *   - "Stresstvilling till Fxx (samma mekanism)" när klusternycklarna är
 *     lika utan nivån stress.
 *
 * Fynden bär standardkörningens värden (seed 1: världar, radhashar, tider,
 * bro, fartyg och invariantmeddelanden ur rapport.json).
 *
 * Mot den gamla motorn (F/pre2): fallen märkta [rättning] fäller den,
 * fallen märkta [vakt] klarar båda motorerna (inga falska länkar) och
 * fallen märkta [nytt] prövar de nya hjälparna i lib/cluster.js.
 * Inga barnprocesser och inga timers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HASH = Object.freeze({
  v254: '877af0fbffc6272f7ed066abad61b11cb16812016217f172e7a94b16ea144fef',
  v1227: 'da8c39082d2b20d4ae6816b96a9b3482727b8ce1d82a139c1fa5e4717689efea',
  v1608: '9dfe35647d542cbf236764f1f8d0180bafef738802753b63b5c8436cc40aca96',
  v1907osc: 'd273b7117ba55ad611df5a86f65fb47779bb2a7485d917d0a9b5513eab7e9f11',
  v1907såg: '186e740575ce3aa507896c374dbc2c4d52a18638a85e283d0a25cbabaa86c3b3',
  v1731: '6c6a22119cca0a463dffdd5ea8be61e347f39c2d20e60ddfe62c0937810e5704',
  v353: 'a90e19fe75ebe5c4fe2e766aeaf6beaff0ef2f93a1cb07bafab93b2d5f06991c',
  v86: 'd61470b1a0b5e25bdb191f1a6c64cea1db33e2a20d8b50bb6c053486128764f4',
});

const iso = (t) => new Date(t).toISOString();
// Testets egen nyckelhjälp (ingen motorfunktion, så fallen kan köras mot F/pre2).
const utanStress = (nyckel) => nyckel.replace(/\|stress$/, '');

/**
 * Ett sanningsspårsfynd som fas 4 lämnar det (krympt representant med
 * recept.radHash), eller okrympt med hela världens radhash.
 */
function syntfynd({
  orakel, klass, inv = null, mmsi = null, bro, t, detalj = '', belägg = {}, nivå = 'R1', värld,
  radHash = null, krympt = true, monitoring = false,
}) {
  const { makeFinding } = require('../lib/finding');
  return makeFinding({
    orakel,
    klass,
    inv,
    allvar: 5,
    mmsi,
    bro,
    riktning: 'southbound',
    t,
    detalj,
    belägg,
    spår: 'synth',
    nivå,
    ursprung: {
      värld, radio: nivå === 'R0' ? 'R0' : 'R1', täthet: nivå === 'stress' ? 'stress' : 'realistisk', familj: 'F-KÖ', båtar: 2, timmar: 1,
    },
    register: { klass: 'KANDIDAT', post: null, närmast: null },
    repro: radHash ? {
      krympt,
      filer: [],
      kommandon: ['node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl', 'npm run hunt:repro -- <fynd>'],
      underlag: krympt ? '1 båt söderut, klass B, 17 rader, 56 min (R1, aisstream).' : 'hela världen (ej krympt).',
      recept: {
        spår: 'synth', värld, radHash, monitoring, krympt,
      },
    } : null,
  });
}

/** Ett invariantutslag (INV-F) ur ett meddelande. */
function invfynd(msg, extra) {
  const sig = require('../lib/signature');
  return syntfynd({
    orakel: 'INV-F',
    klass: sig.invariantClass(msg),
    inv: sig.invIdOf(msg),
    bro: sig.bridgeOf(msg),
    mmsi: sig.mmsiOf(msg),
    t: sig.timeOf(msg),
    detalj: msg,
    belägg: { meddelande: msg },
    ...extra,
  });
}

/** T3-varning efter sann passage (värld, bro, fartyg, varningstid, passagetid). */
function t3efter({
  värld, bro, mmsi, tVarning, tPassage, nivå, radHash, monitoring,
}) {
  return syntfynd({
    orakel: 'T3',
    klass: 'VARNING-EFTER-SANN-PASSAGE',
    mmsi,
    bro,
    t: tVarning,
    detalj: `varning ${bro} kom EFTER att medlemmen ${mmsi} enligt L0 passerade ${bro}`,
    belägg: { varning: { t: tVarning }, sannPassage: { mmsi, t: iso(tPassage) }, senasteFix: iso(tVarning - 20 * 60000) },
    nivå,
    värld,
    radHash,
    monitoring,
  });
}

function t3fruset({
  värld, bro, mmsi, tVarning, nivå, radHash, monitoring,
}) {
  return syntfynd({
    orakel: 'T3',
    klass: 'VARNING-PÅ-FRUSET-FIX',
    mmsi,
    bro,
    t: tVarning,
    detalj: `varning ${bro} med medlem ${mmsi} vars senaste fix är 26 min gammal`,
    belägg: { varning: { t: tVarning }, senasteFix: iso(tVarning - 26 * 60000) },
    nivå,
    värld,
    radHash,
    monitoring,
  });
}

function t2ledtid({
  värld, bro, mmsi, tKorsning, nivå, radHash,
}) {
  return syntfynd({
    orakel: 'T2',
    klass: 'LEDTID<60s',
    mmsi,
    bro,
    t: tKorsning,
    detalj: `varning bara 47 s före sann korsning (värld ${värld})`,
    belägg: { korsningT: tKorsning, varning: { t: iso(tKorsning - 47000) } },
    nivå,
    värld,
    radHash,
  });
}

/**
 * Körningsobjekt med kluster; `reps` väljer representanter per kluster
 * (det fas 4 gör) med en funktion mekanism|nivå → fynd.
 */
function körningMed(fynd, reps = {}) {
  const { clusterFindings } = require('../lib/cluster');
  const { loadRegistry } = require('../lib/registry');
  const { getProfile } = require('../lib/profiles');
  const kluster = clusterFindings(fynd);
  for (const c of kluster) {
    const val = reps[c.nyckel];
    if (val) c.representanter = val.map((f) => c.fynd.find((x) => x === f)).filter(Boolean);
  }
  return {
    motorversion: 'test',
    git: {
      före: {
        finns: false, sha: null, sha7: 'nogit', ändrat: null,
      },
    },
    profil: getProfile('standard'),
    seed: 1,
    spår: ['synth'],
    korpusar: [],
    körningsId: 'abc',
    hälsa: { självtest: { status: 'EJ KÖRT', text: '' } },
    sammanfattning: [],
    fynd,
    kluster,
    register: loadRegistry(),
    täckning: { rader: [] },
    tid: {},
  };
}

/** Kortets id för en klusternyckel. */
function kortFör(urval, nyckel) {
  const k = urval.kort.find((x) => x.kluster.nyckel === nyckel);
  if (!k) throw new Error(`inget kort för ${nyckel}`);
  return k.id;
}

/** Kortets block (### Fxx … ```) ur rapport.md. */
function kortblock(md, id) {
  const i = md.indexOf(`### ${id} · `);
  if (i < 0) return '';
  const j = md.indexOf('```\n', md.indexOf('```', i) + 3);
  return md.slice(i, j + 3);
}

function länkarIJson(json, id) {
  const c = json.kluster.find((x) => x.kort === id);
  return (c && c.länkar) || [];
}

const N13 = 'KANDIDAT|-|INV-F|INV-13 MÅLBRO SOM MELLANBRO|synt';
const N16 = 'KANDIDAT|-|T10|FANTOMPASSAGE(intermediate)|synt';

// Standardkörningens F12 och F16: samma minsta repro i värld 254 (17 rader).
function f12f16() {
  const T = 1784737009875; // 2026-07-22T16:16:49.875Z
  const msg = (t, mmsi) => `MÅLBRO SOM MELLANBRO: ${iso(t)} ${mmsi} fick Stridsbergsbron registrerad som intermediate utan korrigering`;
  const a1 = invfynd(msg(T, '265841261'), { värld: 254, radHash: HASH.v254 });
  const a2 = invfynd(msg(1784860499149, '265709561'), { värld: 1227, radHash: HASH.v1227, monitoring: true });
  const b1 = syntfynd({
    orakel: 'T10',
    klass: 'FANTOMPASSAGE(intermediate)',
    mmsi: '265841261',
    bro: 'Stridsbergsbron',
    t: T,
    detalj: 'appen registrerade intermediate-passage av Stridsbergsbron 16:16:49 men ingen korsning av bron förklarar den',
    belägg: { passage: { slag: 'intermediate', t: iso(T) } },
    värld: 254,
    radHash: HASH.v254,
  });
  return { fynd: [a1, a2, b1], reps: { [N13]: [a1, a2], [N16]: [b1] } };
}

const NOSC = 'KANDIDAT|-|INV-F|INV-3 ETA-OSCILLATION|synt|stress';
const NSÅG = 'KANDIDAT|-|INV-F|INV-3 ETA-SÅGTAND UPP|synt|stress';

// Standardkörningens F18 och F19: samma textövergång i stressvärldarna 1608
// (samma minsta repro) och 1907 (olika minsta repro, överlappande episoder).
function f18f19({ sågtand1907 = 'ETA-SÅGTAND UPP: 2026-09-18T11:01:40.985Z Klaffbron 0.5→7 på 81s' } = {}) {
  const ex = (värld, radHash, monitoring) => ({
    nivå: 'stress', värld, radHash, monitoring,
  });
  const o1 = invfynd('ETA-OSCILLATION: 2026-06-13T09:42:15.347Z Stridsbergsbron 0.5→7→0.5 inom 66s', ex(1608, HASH.v1608, false));
  const o2 = invfynd('ETA-OSCILLATION: 2026-09-18T11:02:03.042Z Klaffbron 0.5→7→0.5 inom 103s', ex(1907, HASH.v1907osc, true));
  const s1 = invfynd('ETA-SÅGTAND UPP: 2026-06-13T09:42:15.101Z Stridsbergsbron 0.5→7 på 65s', ex(1608, HASH.v1608, false));
  const s2 = invfynd(sågtand1907, ex(1907, HASH.v1907såg, true));
  return { fynd: [o1, o2, s1, s2], reps: { [NOSC]: [o1, o2], [NSÅG]: [s1, s2] } };
}

describe('E8: tvillinglänkar i rapporten', () => {
  test('[rättning] F12/F16-mönstret: samma minsta repro länkas åt båda hållen i rapport.md och rapport.json', () => {
    const report = require('../lib/report');
    const { fynd, reps } = f12f16();
    const k = körningMed(fynd, reps);
    const urval = report.assignCards(k.kluster);
    const a = kortFör(urval, N13);
    const b = kortFör(urval, N16);
    const md = report.renderReportMd(k, urval);
    expect(kortblock(md, a)).toMatch(new RegExp(`\\nLänkar: +Samma minsta repro som ${b} \\(troligen samma apphändelse\\): r1 = ${b}:s r1 \\(värld 254\\)\\.\\n`));
    expect(kortblock(md, b)).toMatch(new RegExp(`\\nLänkar: +Samma minsta repro som ${a} \\(troligen samma apphändelse\\): r1 = ${a}:s r1 \\(värld 254\\)\\.\\n`));
    // Länkraden står mellan registerraden och nästa steg.
    const blk = kortblock(md, a);
    expect(blk.indexOf('Register:')).toBeLessThan(blk.indexOf('Länkar:'));
    expect(blk.indexOf('Länkar:')).toBeLessThan(blk.indexOf('Nästa steg:'));
    // Översikten överst i Kandidater listar paret en gång.
    const [x, y] = [a, b].sort();
    expect(md).toMatch(new RegExp(`## Kandidater\\n\\nLänkade kort \\(korten slås inte ihop[^\\n]*\\n- ${x} ↔ ${y}: samma minsta repro \\(troligen samma apphändelse\\)\\.\\n`));
    const json = report.buildReportJson(k, urval);
    expect(länkarIJson(json, a)).toEqual([expect.objectContaining({
      typ: 'samma-repro',
      kort: b,
      nyckel: N16,
      belägg: {
        par: [{
          här: 'r1', där: 'r1', underlag: 'värld 254', radHash: HASH.v254,
        }],
      },
    })]);
    expect(länkarIJson(json, b)).toEqual([expect.objectContaining({ typ: 'samma-repro', kort: a, nyckel: N13 })]);
    // Korten slås inte ihop.
    expect(urval.kort).toHaveLength(2);
  });

  test('[rättning] F18/F19-mönstret: samma minsta repro i värld 1608 och samma utslag även i 1907', () => {
    const report = require('../lib/report');
    const { fynd, reps } = f18f19();
    const k = körningMed(fynd, reps);
    const urval = report.assignCards(k.kluster);
    const osc = kortFör(urval, NOSC);
    const såg = kortFör(urval, NSÅG);
    const md = report.renderReportMd(k, urval);
    const blk = kortblock(md, osc);
    expect(blk).toMatch(new RegExp(`Länkar: +Samma minsta repro som ${såg} \\(troligen samma apphändelse\\): r1 = ${såg}:s r1 \\(värld 1608\\)\\.`));
    // r2 har olika minsta repro, men episoderna överlappar vid Klaffbron i 1907.
    expect(blk).toMatch(new RegExp(`\\n {14}Samma utslag som ${såg} i 2 världar \\(troligen samma apphändelse där\\): 1608 \\(r1 här, ${såg}:s r1\\), 1907 \\(r2 här, ${såg}:s r2\\)\\.`));
    expect(kortblock(md, såg)).toMatch(new RegExp(`Samma utslag som ${osc} i 2 världar \\(troligen samma apphändelse där\\): 1608 \\(r1 här, ${osc}:s r1\\), 1907 \\(r2 här, ${osc}:s r2\\)\\.`));
    const json = report.buildReportJson(k, urval);
    expect(länkarIJson(json, osc).map((l) => [l.typ, l.kort])).toEqual([['samma-repro', såg], ['samma-utslag', såg]]);
    expect(länkarIJson(json, osc)[1].belägg).toEqual({
      antal: 2,
      enhet: 'värld',
      underlag: [{ underlag: 'värld 1608', här: ['r1'], där: ['r1'] }, { underlag: 'värld 1907', här: ['r2'], där: ['r2'] }],
    });
  });

  test('[rättning] stresstvillingar länkas åt båda hållen, bara med samma mekanism', () => {
    const report = require('../lib/report');
    // F03/F20 (T3 VARNING-EFTER-SANN-PASSAGE) och F02/F22 (T2 LEDTID<60s).
    const r0 = t3efter({
      värld: 131, bro: 'Stridsbergsbron', mmsi: '265287813', tVarning: 1788614903080, tPassage: 1788614880971, nivå: 'R0', radHash: 'aa'.repeat(32),
    });
    const st = t3efter({
      värld: 1486, bro: 'Klaffbron', mmsi: '265519324', tVarning: 1788697210313, tPassage: 1788696943220, nivå: 'stress', radHash: 'bb'.repeat(32),
    });
    const l0 = t2ledtid({
      värld: 452, bro: 'Stridsbergsbron', mmsi: '265440188', tKorsning: 1785514895444, nivå: 'R0', radHash: 'cc'.repeat(32),
    });
    const ls = t2ledtid({
      värld: 47, bro: 'Stridsbergsbron', mmsi: '265926032', tKorsning: 1781715572621, nivå: 'stress', radHash: 'dd'.repeat(32),
    });
    // En stressmekanism utan tvilling.
    const ensam = t3fruset({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: '265183171', tVarning: 1789732256508, nivå: 'stress', radHash: 'ee'.repeat(32), monitoring: true,
    });
    const k = körningMed([r0, st, l0, ls, ensam]);
    const urval = report.assignCards(k.kluster);
    const id = (n) => kortFör(urval, n);
    const T3 = 'KANDIDAT|-|T3|VARNING-EFTER-SANN-PASSAGE|synt';
    const T2 = 'KANDIDAT|-|T2|LEDTID<Ns|synt';
    const FR = 'KANDIDAT|-|T3|VARNING-PÅ-FRUSET-FIX|synt|stress';
    const md = report.renderReportMd(k, urval);
    expect(kortblock(md, id(`${T3}|stress`))).toMatch(new RegExp(`\\nLänkar: +Stresstvilling till ${id(T3)} \\(samma mekanism\\)\\.\\n`));
    expect(kortblock(md, id(T3))).toMatch(new RegExp(`\\nLänkar: +Stresstvilling till ${id(`${T3}|stress`)} \\(samma mekanism\\)\\.\\n`));
    expect(kortblock(md, id(`${T2}|stress`))).toMatch(new RegExp(`\\nLänkar: +Stresstvilling till ${id(T2)} \\(samma mekanism\\)\\.\\n`));
    expect(kortblock(md, id(T2))).toMatch(new RegExp(`\\nLänkar: +Stresstvilling till ${id(`${T2}|stress`)} \\(samma mekanism\\)\\.\\n`));
    expect(kortblock(md, id(FR))).not.toMatch(/Länkar:/);
    const json = report.buildReportJson(k, urval);
    expect(länkarIJson(json, id(`${T3}|stress`))).toEqual([{
      typ: 'stresstvilling', kort: id(T3), nyckel: T3, text: `Stresstvilling till ${id(T3)} (samma mekanism).`, belägg: { mekanism: 'T3|VARNING-EFTER-SANN-PASSAGE', nivå: 'R0' },
    }]);
    expect(länkarIJson(json, id(FR))).toEqual([]);
    // Översikten tar varje par en gång.
    const pars = md.split('\n').filter((l) => / ↔ /.test(l));
    expect(pars).toHaveLength(2);
    expect(pars.every((l) => /: stresstvillingar \(samma mekanism\)\.$/.test(l))).toBe(true);
  });

  test('[rättning] F20/F23-mönstret: ett representantutslag som ingår i ett annat korts kluster länkas', () => {
    const report = require('../lib/report');
    const MMSI = '265183171';
    const T = 1789732256508; // 2026-09-18T11:50:56.508Z, Stridsbergsbron#34
    const e1 = t3efter({
      värld: 1486, bro: 'Klaffbron', mmsi: '265519324', tVarning: 1788697210313, tPassage: 1788696943220, nivå: 'stress', radHash: 'bb'.repeat(32),
    });
    const e2 = t3efter({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: '265182462', tVarning: 1789725769570, tPassage: 1789725712540, nivå: 'stress', radHash: 'b2'.repeat(32), monitoring: true,
    });
    // Medlem (ingen representant): samma varning som FRUSET-FIX-kortets.
    const e3 = t3efter({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: MMSI, tVarning: T, tPassage: 1789731750180, nivå: 'stress', radHash: 'b3'.repeat(32), monitoring: true,
    });
    const fr = t3fruset({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: MMSI, tVarning: T, nivå: 'stress', radHash: 'ee'.repeat(32), monitoring: true,
    });
    const NE = 'KANDIDAT|-|T3|VARNING-EFTER-SANN-PASSAGE|synt|stress';
    const NF = 'KANDIDAT|-|T3|VARNING-PÅ-FRUSET-FIX|synt|stress';
    const k = körningMed([e1, e2, e3, fr], { [NE]: [e1, e2], [NF]: [fr] });
    const urval = report.assignCards(k.kluster);
    const e = kortFör(urval, NE);
    const f = kortFör(urval, NF);
    const md = report.renderReportMd(k, urval);
    expect(kortblock(md, f)).toMatch(new RegExp(`\\nLänkar: +Samma utslag som ${e} i 1 värld \\(troligen samma apphändelse där\\): 1907 \\(r1 här\\)\\.\\n`));
    expect(kortblock(md, e)).toMatch(new RegExp(`\\nLänkar: +Samma utslag som ${f} i 1 värld \\(troligen samma apphändelse där\\): 1907 \\(${f}:s r1\\)\\.\\n`));
    const [x, y] = [e, f].sort();
    expect(md).toMatch(new RegExp(`\\n- ${x} ↔ ${y}: samma utslag i 1 värld \\(troligen samma apphändelse där\\)\\.\\n`));
    const json = report.buildReportJson(k, urval);
    expect(länkarIJson(json, e)).toEqual([expect.objectContaining({
      typ: 'samma-utslag', kort: f, belägg: { antal: 1, enhet: 'värld', underlag: [{ underlag: 'värld 1907', här: [], där: ['r1'] }] },
    })]);
  });

  test('[rättning] writeReport: länkar via r2 (F10/F13-mönstret) i rapport.md, rapport.json och kortens kataloger', () => {
    const report = require('../lib/report');
    const MMSI = '265781143';
    const tK = 1786705497267; // korsningen 11:04:57.267 norrut, Stridsbergsbron
    const tN = 1786705596748; // notisen 11:06:36.748
    const t10 = (värld, bro, mmsi, t, radHash, monitoring) => syntfynd({
      orakel: 'T10', klass: 'PASSAGE-EJ-REGISTRERAD', mmsi, bro, t, belägg: { korsningT: t, korsning: { dir: 'nord', t: iso(t) } }, värld, radHash, monitoring,
    });
    const t1 = (värld, bro, mmsi, t, tKors, radHash, monitoring) => syntfynd({
      orakel: 'T1', klass: 'FÖRVARNINGSFORM-EFTER-PASSAGE', mmsi, bro, t, belägg: { korsningT: tKors, korsning: { dir: 'nord', t: iso(tKors) }, notis: { t: iso(t) } }, värld, radHash, monitoring,
    });
    const a1 = t10(353, 'Klaffbron', '265196010', 1782379395951, HASH.v353, false);
    const a2 = t10(1731, 'Stridsbergsbron', MMSI, tK, HASH.v1731, true);
    const b1 = t1(86, 'Olidebron', '265316661', 1781773052513, 1781772998988, HASH.v86, false);
    const b2 = t1(1731, 'Stridsbergsbron', MMSI, tN, tK, HASH.v1731, true);
    const NA = 'KANDIDAT|-|T10|PASSAGE-EJ-REGISTRERAD|synt';
    const NB = 'KANDIDAT|-|T1|FÖRVARNINGSFORM-EFTER-PASSAGE|synt';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-g-tvilling-'));
    try {
      const k = { ...körningMed([a1, a2, b1, b2], { [NA]: [a1, a2], [NB]: [b1, b2] }), ut: { dir: path.join(dir, 'ut'), bas: null, källa: 'flagga' } };
      const res = report.writeReport(k, { representanter: (c) => c.representanter || [c.fynd[0]] });
      const json = JSON.parse(fs.readFileSync(res.json, 'utf8'));
      const ida = json.kluster.find((c) => c.nyckel === NA).kort;
      const idb = json.kluster.find((c) => c.nyckel === NB).kort;
      expect(länkarIJson(json, ida)).toEqual([expect.objectContaining({
        typ: 'samma-repro',
        kort: idb,
        belägg: {
          par: [{
            här: 'r2', där: 'r2', underlag: 'värld 1731', radHash: HASH.v1731,
          }],
        },
      })]);
      expect(länkarIJson(json, idb)).toEqual([expect.objectContaining({ typ: 'samma-repro', kort: ida })]);
      const md = fs.readFileSync(res.md, 'utf8');
      expect(kortblock(md, ida)).toMatch(new RegExp(`Länkar: +Samma minsta repro som ${idb} \\(troligen samma apphändelse\\): r2 = ${idb}:s r2 \\(värld 1731\\)\\.`));
      // r2 är underkatalogen r2/ i kortets katalog.
      const { katalog } = json.kluster.find((c) => c.kort === ida);
      expect(fs.existsSync(path.join(k.ut.dir, katalog, 'r2', 'fynd.json'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('[vakt] inga falska länkar: okrympt värld, annat monitoringläge, annan tid, bro eller annat fartyg', () => {
    const report = require('../lib/report');
    const VÄRLD = 'f0'.repeat(32);
    // Två okrympta representanter ur samma värld bär hela världens radhash
    // (inget minsta repro), och utslagen ligger en timme isär.
    const u1 = t3efter({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: '265182462', tVarning: 1789725769570, tPassage: 1789725712540, nivå: 'R1', radHash: VÄRLD,
    });
    const u2 = t3fruset({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: '265183171', tVarning: 1789729369570, nivå: 'R1', radHash: VÄRLD,
    });
    u1.repro.krympt = false;
    u2.repro.krympt = false;
    // Samma rader men annat monitoringläge är ett annat replaykommando.
    const m1 = t2ledtid({
      värld: 18, bro: 'Klaffbron', mmsi: '265000001', tKorsning: 1785000000000, nivå: 'R1', radHash: 'ab'.repeat(32),
    });
    const m2 = syntfynd({
      orakel: 'T9', klass: 'FEL-RIKTNING', mmsi: '265000002', bro: 'Klaffbron', t: 1785000600000, värld: 19, radHash: 'ab'.repeat(32), monitoring: true,
    });
    // Samma värld, fartyg och tid men annan bro (F14/F01-mönstret, här med samma tid),
    // och samma bro och tid men annat fartyg.
    const b1 = syntfynd({
      orakel: 'T3', klass: 'FANTOM-UTAN-AVBROTT', mmsi: '265533681', bro: 'Klaffbron', t: 1786879972664, belägg: { varning: { t: 1786879972664 } }, värld: 227, radHash: '01'.repeat(32),
    });
    const b2 = syntfynd({
      orakel: 'T2', klass: 'ÖPPNING-MISS:OKLASSAD', mmsi: '265533681', bro: 'Stridsbergsbron', t: 1786879972664, belägg: { korsningT: 1786879972664 }, värld: 227, radHash: '02'.repeat(32),
    });
    const b3 = syntfynd({
      orakel: 'T10', klass: 'PASSAGE-EJ-REGISTRERAD', mmsi: '265999999', bro: 'Klaffbron', t: 1786879972664, belägg: { korsningT: 1786879972664 }, värld: 227, radHash: '03'.repeat(32),
    });
    // Ett textutslag utan fartyg möter inte ett fartygsutslag.
    const b4 = invfynd('ETA-SÅGTAND UPP: 2026-08-16T11:32:52.664Z Klaffbron 3→9 på 30s', { värld: 227, radHash: '04'.repeat(32) });
    const k = körningMed([u1, u2, m1, m2, b1, b2, b3, b4]);
    const urval = report.assignCards(k.kluster);
    expect(urval.kort).toHaveLength(8);
    const md = report.renderReportMd(k, urval);
    expect(md).not.toMatch(/Länkar:/);
    expect(md).not.toMatch(/Länkade kort/);
    const json = report.buildReportJson(k, urval);
    expect(json.kluster.every((c) => (c.länkar || []).length === 0)).toBe(true);
  });

  test('[rättning] F18/F19 med stresstvillingarna (F06/F04-mönstret): länkarna sorteras på det andra kortet och typen', () => {
    const report = require('../lib/report');
    const { fynd, reps } = f18f19();
    // R0-tvillingarna i andra världar (standardkörningens F06 och F04).
    const o0 = invfynd('ETA-OSCILLATION: 2026-09-11T12:00:00.739Z Klaffbron 0.5→4→0.5 inom 30s', { nivå: 'R0', värld: 192, radHash: '19'.repeat(32) });
    const s0 = invfynd('ETA-SÅGTAND UPP: 2026-06-22T11:31:47.306Z Stridsbergsbron 6→16 på 50s', { nivå: 'R0', värld: 884, radHash: '88'.repeat(32) });
    const k = körningMed([...fynd, o0, s0], reps);
    const urval = report.assignCards(k.kluster);
    const id = (n) => kortFör(urval, n);
    const json = report.buildReportJson(k, urval);
    // Stressklustret får sin R0-tvilling (lägre id) före samma repro och samma utslag.
    expect(länkarIJson(json, id(NOSC)).map((l) => [l.typ, l.kort])).toEqual([
      ['stresstvilling', id(utanStress(NOSC))], ['samma-repro', id(NSÅG)], ['samma-utslag', id(NSÅG)],
    ]);
    expect(länkarIJson(json, id(utanStress(NSÅG))).map((l) => [l.typ, l.kort])).toEqual([['stresstvilling', id(NSÅG)]]);
    const blk = kortblock(report.renderReportMd(k, urval), id(NOSC));
    expect(blk.indexOf('Stresstvilling till')).toBeLessThan(blk.indexOf('Samma minsta repro som'));
    expect(blk.indexOf('Samma minsta repro som')).toBeLessThan(blk.indexOf('Samma utslag som'));
  });

  test('[vakt] F18/F19 med episoder som inte överlappar i 1907: inget samma utslag (samma minsta repro i 1608 räcker inte)', () => {
    const report = require('../lib/report');
    const { fynd, reps } = f18f19({ sågtand1907: 'ETA-SÅGTAND UPP: 2026-09-18T11:31:40.985Z Klaffbron 0.5→7 på 81s' });
    const k = körningMed(fynd, reps);
    const urval = report.assignCards(k.kluster);
    expect(report.renderReportMd(k, urval)).not.toMatch(/Samma utslag som|samma utslag i/);
    const json = report.buildReportJson(k, urval);
    const osc = kortFör(urval, NOSC);
    expect(länkarIJson(json, osc).filter((l) => l.typ === 'samma-utslag')).toEqual([]);
  });

  test('[rättning] rapport.json med länkar är deterministisk oberoende av fyndens ordning', () => {
    const report = require('../lib/report');
    const a = f12f16();
    const b = f18f19();
    const lista = [...a.fynd, ...b.fynd];
    const reps = { ...a.reps, ...b.reps };
    const k1 = körningMed(lista, reps);
    const k2 = körningMed([...lista].reverse(), reps);
    const j1 = report.buildReportJson(k1, report.assignCards(k1.kluster));
    const j2 = report.buildReportJson(k2, report.assignCards(k2.kluster));
    expect(report.stableStringify(report.withoutTime(j1))).toBe(report.stableStringify(report.withoutTime(j2)));
    expect(j1.kluster.filter((c) => c.länkar.length).map((c) => c.kort).sort()).toEqual(['F01', 'F02', 'F03', 'F04']);
  });

  test('[rättning] en stresstvilling utanför de 25 korten länkas med nyckel, utan kort-id', () => {
    const report = require('../lib/report');
    const { MAX_KORT } = require('../lib/profiles');
    const bokstav = (i) => String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
    // 25 R0-mekanismer fyller korten; stressklustret för den första hamnar utanför.
    const fynd = [];
    for (let i = 0; i < MAX_KORT; i++) {
      fynd.push(syntfynd({
        orakel: 'T3', klass: `FANTOM:${bokstav(i)}`, mmsi: '265000100', bro: 'Klaffbron', t: 1785000000000 + (i * 3600000), nivå: 'R0', värld: 100 + i, radHash: null,
      }));
    }
    fynd.push(syntfynd({
      orakel: 'T3', klass: 'FANTOM:AA', mmsi: '265000200', bro: 'Klaffbron', t: 1786000000000, nivå: 'stress', värld: 900, radHash: null,
    }));
    const k = körningMed(fynd);
    const urval = report.assignCards(k.kluster);
    expect(urval.kort).toHaveLength(MAX_KORT);
    expect(urval.överskott.map((c) => c.nyckel)).toEqual(['KANDIDAT|-|T3|FANTOM:AA|synt|stress']);
    const id = kortFör(urval, 'KANDIDAT|-|T3|FANTOM:AA|synt');
    const json = report.buildReportJson(k, urval);
    expect(länkarIJson(json, id)).toEqual([{
      typ: 'stresstvilling',
      kort: null,
      nyckel: 'KANDIDAT|-|T3|FANTOM:AA|synt|stress',
      text: `Stresstvilling till klustret T3|FANTOM:AA (stress) (samma mekanism; utanför de ${MAX_KORT} korten, finns i rapport.json).`,
      belägg: { mekanism: 'T3|FANTOM:AA', nivå: 'stress' },
    }]);
    expect(report.renderReportMd(k, urval)).toMatch(new RegExp(`- ${id} ↔ klustret T3\\|FANTOM:AA: stresstvillingar \\(samma mekanism\\)\\.`));
  });
});

describe('E8: relationerna i lib/cluster.js', () => {
  test('[nytt] utanStress, reproIdentitet och utslagsplats', () => {
    const cl = require('../lib/cluster');
    expect(cl.utanStress('KANDIDAT|-|T2|LEDTID<Ns|synt|stress')).toBe('KANDIDAT|-|T2|LEDTID<Ns|synt');
    expect(cl.utanStress('KANDIDAT|-|T2|LEDTID<Ns|synt')).toBe('KANDIDAT|-|T2|LEDTID<Ns|synt');
    const f = t2ledtid({
      värld: 47, bro: 'Stridsbergsbron', mmsi: '265926032', tKorsning: 1781715572621, nivå: 'stress', radHash: 'dd'.repeat(32),
    });
    expect(cl.reproIdentitet(f)).toBe(`${'dd'.repeat(32)}|monitoring=0`);
    f.repro.krympt = false;
    expect(cl.reproIdentitet(f)).toBeNull();
    expect(cl.utslagsplats(f)).toBe('synth|värld:47|Stridsbergsbron|265926032');
    // Kanarier och fynd utan underlag länkas aldrig.
    expect(cl.utslagsplats({ ...f, ursprung: { kanarie: 'K1' } })).toBeNull();
  });

  test('[nytt] utslagsfönster: händelseparet och episodlängden, inte kontextfälten', () => {
    const cl = require('../lib/cluster');
    const T = 1789729323042;
    // ETA-OSCILLATION och SÅGTAND UPP: tiden är episodens slut.
    const osc = invfynd('ETA-OSCILLATION: 2026-09-18T11:02:03.042Z Klaffbron 0.5→7→0.5 inom 103s', { värld: 1907, radHash: null });
    expect(cl.utslagsfönster(osc)).toEqual({ från: T - 103000, till: T });
    // DEFAULT-FLASH: tiden är starten, (Ns) hur länge texten stod.
    const flash = invfynd('DEFAULT-FLASH: 2026-08-05T13:06:30.040Z "Inga båtar" inklämd (81s) mellan två "En … Stridsbergsbron"-texter utan passage', { värld: 5, radHash: null });
    expect(cl.utslagsfönster(flash)).toEqual({ från: flash.t, till: flash.t + 81000 });
    // T3: från den sanna passagen till varningen; senasteFix ingår inte.
    const e = t3efter({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: '265183171', tVarning: 1789732256508, tPassage: 1789731750180, nivå: 'stress', radHash: null,
    });
    expect(cl.utslagsfönster(e)).toEqual({ från: 1789731750180, till: 1789732256508 });
    // T2 LEDTID: från varningen till korsningen.
    const l = t2ledtid({
      värld: 452, bro: 'Stridsbergsbron', mmsi: '265440188', tKorsning: 1785514895444, nivå: 'R0', radHash: null,
    });
    expect(cl.utslagsfönster(l)).toEqual({ från: 1785514895444 - 47000, till: 1785514895444 });
    // Utan tid inget fönster (H1–H3).
    expect(cl.utslagsfönster({ ...l, t: null })).toBeNull();
    // Samma utslag: överlappande fönster, samma underlag, bro och fartyg.
    const fr = t3fruset({
      värld: 1907, bro: 'Stridsbergsbron', mmsi: '265183171', tVarning: 1789732256508, nivå: 'stress', radHash: null,
    });
    expect(cl.sammaUtslag(e, fr)).toBe(true);
    expect(cl.sammaUtslag(e, { ...fr, t: 1789732256508 + 1, belägg: { varning: { t: 1789732256508 + 1 } } })).toBe(false);
    expect(cl.sammaUtslag(e, { ...fr, ursprung: { ...fr.ursprung, värld: 1906 } })).toBe(false);
  });
});
