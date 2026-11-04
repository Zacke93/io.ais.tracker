'use strict';

/**
 * Buggjägaren steg 4: klustring och rapport v0. Rena funktioner plus en
 * skrivning till en tempkatalog — inga barnprocesser, inga timers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const T0 = Date.parse('2026-07-10T08:35:12.000Z');

function mfas(overrides = {}) {
  const { makeFinding } = require('../lib/finding');
  return makeFinding({
    orakel: 'M-FAS',
    klass: 'ÖPPNINGSNYCKEL TILLAGD',
    allvar: 4,
    mmsi: '265552100',
    bro: 'Klaffbron',
    riktning: 'northbound',
    t: T0,
    detalj: 'varianten har en öppningsvarning Klaffbron northbound som basen saknar',
    belägg: { tillagda: [{ bridge: 'Klaffbron', direction: 'northbound', t: T0 }] },
    spår: 'bank',
    nivå: 'bank',
    ursprung: {
      korpus: '20260710-13h', relation: 'M-FAS', deltaS: [-11.52], rader: 302,
    },
    taggar: ['KNIVSEGG'],
    repro: {
      filer: [{ från: '/finns/inte/variant.jsonl', till: 'variant.jsonl' }],
      kommandon: ['node tests/replay-validation/replayRunner.js <fynd>/variant.jsonl', 'npm run hunt:repro -- <fynd>'],
      underlag: 'bas och variant, 302 rader, 7 h 30 min (bankfynd krymps inte i v1).',
      tidslinje: ['08:35:12  variant  öppningsvarning Klaffbron norrut ledare 265552100'],
      recept: { korpus: '20260710-13h', relation: 'M-FAS', deltaS: -11.52 },
    },
    register: {
      klass: 'KANDIDAT',
      post: null,
      närmast: {
        post: 'K20-FASKÄNSLIG-LEDARE', klass: 'KÄND_ÖPPEN', skäl: 'predikatet falskt: inget parat kortbyte', källa: 'docs/ARCHITECTURE.md:752–760',
      },
    },
    ...overrides,
  });
}

function inv(korpus, msg, register, extra = {}) {
  const { makeFinding } = require('../lib/finding');
  const sig = require('../lib/signature');
  return makeFinding({
    orakel: 'INV-F',
    klass: sig.invariantClass(msg),
    inv: sig.invIdOf(msg),
    allvar: 4,
    bro: sig.bridgeOf(msg),
    t: sig.timeOf(msg),
    detalj: msg,
    spår: 'bank',
    nivå: 'bank',
    ursprung: { korpus, relation: 'M-FAS', deltaS: [7, -11.52] },
    taggar: ['KNIVSEGG'],
    register,
    ...extra,
  });
}

function körningOf(fynd) {
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
    spår: ['selftest', 'bank'],
    korpusar: [{ id: '20260710-13h' }, { id: '20260708-21h' }, { id: '20260806-42h' }],
    körningsId: 'abc',
    hälsa: { självtest: { status: 'GRÖNT', text: 'determinism 24/24' } },
    sammanfattning: ['rad 1', 'rad 2', 'rad 3'],
    kluster: clusterFindings(fynd),
    register: loadRegistry(),
    täckning: {
      rader: [{
        spår: 'bank', orakel: 'M-FAS', prövat: 48, utslag: 4,
      }],
    },
    tid: { start: new Date().toISOString(), väggtidMs: Math.random() * 1000 },
  };
}

const FLASH42 = 'DEFAULT-FLASH: 2026-08-06T08:47:07.040Z "Inga båtar" inklämd (56s) mellan två "En … Stridsbergsbron"-texter utan passage';
const SAGTAND = 'ETA-SÅGTAND UPP: 2026-07-08T09:12:30.000Z Klaffbron 3→9 på 30s';

describe('buggjägaren: klustring och rapport', () => {
  test('(1) klusternyckeln påverkas inte av bro, riktning, era eller taggar', () => {
    const { clusterKey } = require('../lib/cluster');
    const a = mfas();
    const b = mfas({
      bro: 'Stridsbergsbron', riktning: 'southbound', taggar: [], ursprung: { korpus: 'x', era: 'aishub', deltaS: [7] },
    });
    expect(clusterKey(a)).toBe(clusterKey(b));
    expect(clusterKey(a)).toBe('KANDIDAT|-|M-FAS|ÖPPNINGSNYCKEL TILLAGD');
    // Registerutfallet och mekanismen ingår däremot.
    expect(clusterKey(mfas({ register: { klass: 'KÄND_ÖPPEN', post: 'K20-FASKÄNSLIG-LEDARE' } }))).not.toBe(clusterKey(a));
    const { clusterFindings } = require('../lib/cluster');
    const cl = clusterFindings([a, b]);
    expect(cl).toHaveLength(1);
    expect(cl[0].fördelning.bro).toEqual({ Klaffbron: 1, Stridsbergsbron: 1 });
    expect(cl[0].oberoende).toBe(2);
  });

  test('poängen: allvar × nivåvikt × (1 + log2 oberoende) × 0,8 vid KNIVSEGG', () => {
    const { clusterFindings } = require('../lib/cluster');
    const [c] = clusterFindings([mfas()]);
    expect(c.poäng).toBeCloseTo(4 * 1.0 * 1 * 0.8, 6);
    const [c2] = clusterFindings([mfas(), mfas({ ursprung: { korpus: 'b', deltaS: [7] }, taggar: [] })]);
    expect(c2.poäng).toBeCloseTo(4 * 1.0 * 2, 6);
  });

  test('(2) två identiska fyndlistor i olika ordning ger byte-identisk rapport.json utom tidsblocket', () => {
    const report = require('../lib/report');
    const list = [
      mfas(),
      inv('20260708-21h', SAGTAND, { klass: 'KANDIDAT', post: null, närmast: null }),
      inv('20260806-42h', FLASH42, { klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS', närmast: null }),
      mfas({ t: T0 + 60000, mmsi: '265000001' }),
    ];
    const shuffled = [list[2], list[3], list[0], list[1]];
    const k1 = körningOf(list);
    const k2 = körningOf(shuffled);
    const j1 = report.buildReportJson(k1, report.assignCards(k1.kluster));
    const j2 = report.buildReportJson(k2, report.assignCards(k2.kluster));
    expect(report.stableStringify(j1.tid)).not.toBe(report.stableStringify(j2.tid));
    expect(report.stableStringify(report.withoutTime(j1))).toBe(report.stableStringify(report.withoutTime(j2)));
    // Inga tempsökvägar i den deterministiska delen.
    expect(report.stableStringify(report.withoutTime(j1))).not.toMatch(/\/finns\/inte/);
  });

  test('(3) ett fixturkort har rubrik, orakel, förekomst, repro-kommando, registerrad och nästa steg', () => {
    const report = require('../lib/report');
    const k = körningOf([mfas()]);
    const urval = report.assignCards(k.kluster);
    expect(urval.kort).toHaveLength(1);
    expect(urval.kort[0].relKatalog).toBe('fynd/F01-ny-oppningsvarning-i-fasvarianten-vid-klaffbron-norrut');
    const md = report.renderCard({ ...urval.kort[0], katalog: '/ut/fynd/F01' }, k.register);
    expect(md).toMatch(/^### F01 · KANDIDAT · bank · allvar 4 — Ny öppningsvarning i fasvarianten vid Klaffbron norrut/);
    expect(md).toMatch(/Orakel: +M-FAS ÖPPNINGSNYCKEL TILLAGD — fasrelationen/);
    expect(md).toMatch(/Förekomst: +1 korpus \(20260710-13h\); δ = −11,52 s; Klaffbron 1; norrut 1\./);
    expect(md).toMatch(/node tests\/replay-validation\/replayRunner\.js \/ut\/fynd\/F01\/variant\.jsonl/);
    expect(md).toMatch(/npm run hunt:repro -- \/ut\/fynd\/F01/);
    expect(md).toMatch(/Register: +ingen post matchar\. Närmast K20-FASKÄNSLIG-LEDARE/);
    expect(md).toMatch(/Nästa steg: +triage/);
  });

  test('rapport.md har avsnitten i designens ordning och kända utfall räknas per post', () => {
    const report = require('../lib/report');
    const k = körningOf([
      mfas(),
      inv('20260806-42h', FLASH42, { klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS', närmast: null }),
    ]);
    const md = report.renderReportMd(k, report.assignCards(k.kluster));
    const order = ['## Hälsa', '## Sammanfattning', '## Nya träffar på låst bank', '## Kandidater',
      '## Beslutsfrågor och konflikter', '## Kända utfall', '## Instrumentfel och mätgränser', '## Täckning'];
    const idx = order.map((h) => md.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(md).toMatch(/\| KIE-PER-KORPUS \| ACCEPTERAD \| INV-F\\\|INV-14 DEFAULT-FLASH \| 1 \|/);
    expect(md).toMatch(/Vad v1 inte prövar:/);
  });

  test('writeReport skriver rapport.md, rapport.json, kortkatalog och senaste.txt (motorns egen baskatalog)', () => {
    const report = require('../lib/report');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-report-test-'));
    try {
      const src = path.join(dir, 'variant-källa.jsonl');
      fs.writeFileSync(src, '{"ctrl":"restart","aisTimestamp":1780000000000}\n');
      const f = mfas({ repro: { ...mfas().repro, filer: [{ från: src, till: 'variant.jsonl' }] } });
      // källa 'tmpdir' = motorns egen baskatalog (os.tmpdir()/ais-tracker-hunt/); med --out skrivs ingen senaste.txt.
      const k = { ...körningOf([f]), ut: { dir: path.join(dir, 'ut', 'körning1'), bas: path.join(dir, 'ut'), källa: 'tmpdir' } };
      const res = report.writeReport(k);
      expect(fs.existsSync(res.md)).toBe(true);
      const json = JSON.parse(fs.readFileSync(res.json, 'utf8'));
      expect(json.kluster[0].kort).toBe('F01');
      expect(json.kluster[0].fynd[0].repro.filer).toEqual([{ till: 'variant.jsonl' }]);
      const cardDir = path.join(k.ut.dir, json.kluster[0].katalog);
      expect(fs.readFileSync(path.join(cardDir, 'variant.jsonl'), 'utf8')).toMatch(/restart/);
      expect(fs.readFileSync(path.join(cardDir, 'kommando.txt'), 'utf8')).toMatch(/hunt:repro -- .*F01/);
      expect(fs.existsSync(path.join(cardDir, 'recept.json'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'ut', 'senaste.txt'), 'utf8')).toBe('körning1\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
