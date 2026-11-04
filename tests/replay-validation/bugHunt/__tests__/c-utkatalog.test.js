'use strict';

/**
 * Rättningsrundan 2026-11-04, M08 och M13: utkatalogens hygien.
 *
 *   M08  Med --out skrivs ingenting utanför utkatalogen; senaste.txt skrivs
 *        bara i motorns egna baskataloger (källorna 'dirigent' och 'tmpdir').
 *   M13  En återanvänd utkatalog töms på den tidigare motorkörningens fynd/
 *        innan den nya rapporten skrivs; en icke-tom katalog med annat
 *        innehåll vägras.
 *
 * Bara skrivningar i en tempkatalog — inga barnprocesser, inga git-anrop.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const T0 = Date.parse('2026-07-10T08:35:12.000Z');

function bankfynd(overrides = {}) {
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
    spår: 'bank',
    nivå: 'bank',
    ursprung: { korpus: '20260710-13h', relation: 'M-FAS', deltaS: [-11.52] },
    taggar: ['KNIVSEGG'],
    repro: {
      filer: [],
      kommandon: ['npm run hunt:repro -- <fynd>'],
      recept: { korpus: '20260710-13h', relation: 'M-FAS', deltaS: -11.52 },
    },
    register: { klass: 'KANDIDAT', post: null, närmast: null },
    ...overrides,
  });
}

function körningMed(fynd, ut) {
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
    spår: ['bank'],
    korpusar: [],
    körningsId: 'abc',
    hälsa: { självtest: { status: 'GRÖNT', text: '' } },
    sammanfattning: [],
    kluster: clusterFindings(fynd),
    register: loadRegistry(),
    täckning: { rader: [] },
    tid: {},
    ut,
  };
}

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-utkatalog-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('M08: senaste.txt bara i motorns egna baskataloger', () => {
  test('med --out skrivs ingenting utanför utkatalogen', () => {
    const hygiene = require('../lib/hygiene');
    const report = require('../lib/report');
    const förälder = path.join(tmp, 'förälder');
    fs.mkdirSync(förälder);
    const ut = hygiene.resolveOutDir({
      root: path.join(tmp, 'repo'), gitLäge: { finns: false, sha7: 'nogit' }, profil: 'quick', seed: 1, out: path.join(förälder, 'ut'),
    });
    expect(ut.källa).toBe('flagga');
    report.writeReport(körningMed([bankfynd()], ut));
    expect(fs.readdirSync(förälder)).toEqual(['ut']);
    expect(fs.existsSync(path.join(förälder, 'ut', 'rapport.json'))).toBe(true);
    expect(hygiene.senastePath(ut)).toBeNull();
  });

  test('källorna dirigent och tmpdir får senaste.txt i baskatalogen; flagga aldrig, även med bas', () => {
    const report = require('../lib/report');
    for (const källa of ['dirigent', 'tmpdir']) {
      const bas = path.join(tmp, källa);
      report.writeReport(körningMed([bankfynd()], { dir: path.join(bas, 'k1'), bas, källa }));
      expect(fs.readFileSync(path.join(bas, 'senaste.txt'), 'utf8')).toBe('k1\n');
    }
    const bas = path.join(tmp, 'ägarens');
    report.writeReport(körningMed([bankfynd()], { dir: path.join(bas, 'k1'), bas, källa: 'flagga' }));
    expect(fs.readdirSync(bas)).toEqual(['k1']);
  });
});

describe('M13: återanvänd --out', () => {
  test('en tidigare motorkörning töms: inga gamla Fnn-kataloger blir kvar', () => {
    const report = require('../lib/report');
    const ut = { dir: path.join(tmp, 'ut'), bas: null, källa: 'flagga' };
    const första = report.writeReport(körningMed([bankfynd()], ut));
    const gammaltKort = path.join(ut.dir, första.kort[0].relKatalog);
    expect(fs.existsSync(path.join(gammaltKort, 'fynd.json'))).toBe(true);
    // Andra körningen i samma --out har inga kort.
    const andra = report.writeReport(körningMed([], ut));
    expect(andra.kort).toHaveLength(0);
    expect(fs.existsSync(gammaltKort)).toBe(false);
    expect(fs.readdirSync(ut.dir).sort()).toEqual(['rapport.json', 'rapport.md']);
    expect(JSON.parse(fs.readFileSync(andra.json, 'utf8')).kluster).toEqual([]);
  });

  test('en icke-tom katalog utan (eller utöver) en tidigare motorkörning vägras och lämnas orörd', () => {
    const hygiene = require('../lib/hygiene');
    const report = require('../lib/report');
    // Främmande innehåll: vägras, och inget skrivs i katalogen.
    const ägarens = path.join(tmp, 'ägarens');
    fs.mkdirSync(ägarens);
    fs.writeFileSync(path.join(ägarens, 'anteckningar.txt'), 'viktigt\n');
    expect(() => report.writeReport(körningMed([bankfynd()], { dir: ägarens, bas: null, källa: 'flagga' }))).toThrow(/inte tom/);
    expect(fs.readdirSync(ägarens)).toEqual(['anteckningar.txt']);
    // Saknas eller tom: får användas.
    const fmt = { format: report.FORMAT };
    expect(hygiene.checkOutDir(path.join(tmp, 'finns-inte'), fmt)).toEqual({ ok: true, tidigare: false, fel: null });
    // rapport.json i ett annat format är ingen motorkörning.
    const annan = path.join(tmp, 'annan');
    fs.mkdirSync(annan);
    fs.writeFileSync(path.join(annan, 'rapport.json'), '{"format":"något-annat/1"}\n');
    expect(hygiene.checkOutDir(annan, fmt).ok).toBe(false);
    // En tidigare motorkörning plus en främmande fil vägras också. (Loggfiler,
    // *.log, är kringfiler som godtas; se d-efterratt.test.js.)
    const blandad = path.join(tmp, 'blandad');
    report.writeReport(körningMed([bankfynd()], { dir: blandad, bas: null, källa: 'flagga' }));
    expect(hygiene.checkOutDir(blandad, fmt)).toEqual({ ok: true, tidigare: true, fel: null });
    fs.writeFileSync(path.join(blandad, 'anteckningar.txt'), 'viktigt\n');
    const c = hygiene.checkOutDir(blandad, fmt);
    expect(c.ok).toBe(false);
    expect(c.fel).toMatch(/anteckningar\.txt/);
    expect(() => report.writeReport(körningMed([], { dir: blandad, bas: null, källa: 'flagga' }))).toThrow(/inte tom/);
    expect(fs.existsSync(path.join(blandad, 'fynd'))).toBe(true);
  });
});
