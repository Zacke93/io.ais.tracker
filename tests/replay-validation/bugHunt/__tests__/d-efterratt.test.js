'use strict';

/**
 * Efterrättningen 2026-11-04 (rättare D): problemen som varv r0:s granskare
 * och körare fann i rättningarna. Varje describe-block har fall som både
 * motorn före rundan (ögonblicksbilden F/pre/bugHunt) och motorn efter
 * varv r0 fäller.
 *
 * Inga barnprocesser (child_process.execFile är en attrapp; poolen injiceras
 * där en replay behövs), inga git-anrop och inga timers. Allt som skrivs
 * hamnar i testets tempkatalog.
 */

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { fromEntries, copyFile } = require('../lib/util');

const MIN = 60000;
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Ett tomt men komplett replayresultat (inga notiser, varningar eller passager). */
const TOMT = Object.freeze({
  notifications: [],
  openingWarnings: [],
  openingCoverage: [],
  openingSuppressions: [],
  openingServiceFires: 0,
  targetPassages: [],
  intermediatePassages: [],
  bridgeTextTransitions: [],
  journeyResets: [],
  visitReentries: [],
  confirmedTargetWaits: [],
  processErrors: 0,
});

/** Poolen ersätts: varje körning svarar med `resultat` (null = körfel). */
function fakePool(resultat) {
  return {
    jobb: 1,
    statistik: {},
    async run(job) {
      return {
        etikett: job.etikett,
        jsonl: job.jsonl,
        ok: !!resultat,
        häng: false,
        fatal: null,
        fel: resultat ? null : 'konstruerat körfel',
        försök: [],
        ms: 1,
        rader: job.rader || 0,
        simTimmar: job.simTimmar || 1,
        resultat: resultat ? clone(resultat) : null,
        stderr: {
          h3: {}, övrigt: {}, rader: 0, exempel: {},
        },
      };
    },
    runAll(jobs) {
      return Promise.all(jobs.map((j) => this.run(j)));
    },
  };
}

let tmp;
let log;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-d-test-'));
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Kör fn med konsolen fångad; returnerar {code, text}. */
async function fånga(fn) {
  const rader = [];
  log.mockImplementation((...a) => rader.push(a.join(' ')));
  const err = jest.spyOn(console, 'error').mockImplementation((...a) => rader.push(a.join(' ')));
  try {
    const code = await fn();
    return { code, text: rader.join('\n') };
  } finally {
    err.mockRestore();
    log.mockImplementation(() => {});
  }
}

// ---------------------------------------------------------------------------
// INV-10 med två målbroar: zombiens bro, inte textens första
// ---------------------------------------------------------------------------

describe('INV-10 med två strax-klausuler: väntan prövas vid zombiens bro', () => {
  const at = (hms) => Date.parse(`2026-08-04T${hms}Z`);
  const TVÅ = 'En båt på väg mot Klaffbron, beräknad broöppning strax; En båt på väg mot Stridsbergsbron, beräknad broöppning strax';
  const INGA = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
  const resultat = (waits) => ({
    bridgeTextTransitions: [
      ['08:45:00.040', INGA], ['08:49:44.879', TVÅ],
      ['09:27:30.040', 'En båt på väg mot Klaffbron, ETA okänd; En båt på väg mot Stridsbergsbron, ETA okänd'], ['09:29:50.523', INGA],
    ].map(([hms, text]) => ({ t: at(hms), iso: `2026-08-04T${hms}Z`, text })),
    confirmedTargetWaits: waits.map(([bridge, a, b]) => ({ bridge, from: at(a), until: at(b) })),
    targetPassages: [],
    intermediatePassages: [],
    notifications: [],
  });
  const domen = (waits) => {
    const existing = require('../lib/oracles/existing');
    const { loadRegistry } = require('../lib/registry');
    const res = resultat(waits);
    const reg = loadRegistry();
    return existing.judgeExisting({ result: res, rows: [], gt: null }).fynd.filter((x) => x.inv === 'INV-10')
      .map((f) => ({ f, c: reg.classify(f, { rader: [], resultat: res }, { räkna: false }) }));
  };

  test('granskarens fall: hel väntan bara vid Klaffbron — zombien vid Stridsbergsbron är KANDIDAT', () => {
    const ut = domen([['Klaffbron', '08:49:44.879', '09:28:00.000']]);
    expect(ut).toHaveLength(1);
    const [{ f, c }] = ut;
    expect(f.detalj).toMatch(/stod 38 min utan Stridsbergsbron-passage$/);
    expect(f.bro).toBe('Stridsbergsbron');
    expect(f.belägg.väntan).toMatchObject({ bro: 'Stridsbergsbron', intervall: [] });
    expect(c.klass).toBe('KANDIDAT');
    expect(c.närmast).toMatchObject({ post: 'MÄTGRÄNS-INV10-VÄNTKEDJA' });
    expect(c.närmast.skäl).toMatch(/vid Stridsbergsbron/);
  });

  test('kedjad väntan vid Klaffbron förklarar bara Klaffbrons zombie', () => {
    const ut = domen([['Klaffbron', '08:49:44.879', '08:59:44.854'], ['Klaffbron', '08:59:57.860', '09:27:04.278']]);
    const per = fromEntries(ut.map(({ f, c }) => [f.bro, { c, väntan: f.belägg.väntan.bro }]));
    expect(Object.keys(per).sort()).toEqual(['Klaffbron', 'Stridsbergsbron']);
    expect(per.Klaffbron).toMatchObject({ väntan: 'Klaffbron', c: { klass: 'MÄTGRÄNS', post: 'MÄTGRÄNS-INV10-VÄNTKEDJA' } });
    expect(per.Stridsbergsbron).toMatchObject({ väntan: 'Stridsbergsbron', c: { klass: 'KANDIDAT' } });
  });

  test('samma väg i en fasvariant (M-FAS): det nya utslaget prövas vid Stridsbergsbron', () => {
    const relations = require('../lib/relations');
    const { loadRegistry } = require('../lib/registry');
    const V = resultat([['Klaffbron', '08:49:44.879', '09:28:00.000']]);
    const base = {
      korpus: { id: 'x', knownInvariantExceptions: [] },
      kc: {
        id: 'x', rader: [], simTimmar: 4, jsonl: '/finns/inte/bas.jsonl', statePath: null,
      },
      resultat: clone(TOMT),
      gt: [],
      fatala: [],
      leverans: [],
    };
    const fynd = relations.comparePhase(base, {
      ok: true, resultat: V, stderr: { h3: {}, exempel: {} }, ms: 1,
    }, {
      deltaS: 7, monitoring: false, fil: { jsonl: '/finns/inte/variant.jsonl', statePath: null }, h3Baslinje: { signaturer: {}, timmar: 4 },
    }).filter((f) => f.inv === 'INV-10');
    expect(fynd).toHaveLength(1);
    expect(fynd[0].bro).toBe('Stridsbergsbron');
    expect(fynd[0].belägg.väntan.bro).toBe('Stridsbergsbron');
    expect(loadRegistry().classify(fynd[0], fynd[0].kontext, { räkna: false }).klass).toBe('KANDIDAT');
  });
});

// ---------------------------------------------------------------------------
// KIE-PER-KORPUS: |δ| + episodens längd + en tick, och en träff per undantag och variant
// ---------------------------------------------------------------------------

describe('KIE-PER-KORPUS: snävt fönster och högst en träff per undantag och variant', () => {
  const k42 = () => require(path.join('..', '..', 'corpora')).find((c) => c.id === '20260806-42h');
  const at = (hms) => Date.parse(`2026-08-06T${hms}Z`);
  const INGA = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
  const en = (m) => `En båt på väg mot Stridsbergsbron, beräknad broöppning om ${m} minuter`;
  const flash = (hms, s) => `DEFAULT-FLASH: 2026-08-06T${hms}Z "Inga båtar" inklämd (${s}s) mellan två "En … Stridsbergsbron"-texter utan passage`;

  /** Ett nytt fatalt utslag i en fasvariant, som relations.comparePhase bygger det (utan syskon). */
  const fasFynd = (msg, deltaS) => {
    const existing = require('../lib/oracles/existing');
    const { makeFinding } = require('../lib/finding');
    const f = existing.fromInvariant(msg, 'INV-F');
    return makeFinding({
      ...f,
      t: f.t - deltaS * 1000,
      belägg: {
        ...f.belägg, meddelanden: [msg], ny: true, tidsram: 'variant',
      },
      spår: 'bank',
      nivå: 'bank',
      ursprung: { korpus: '20260806-42h', relation: 'M-FAS', deltaS: [deltaS] },
      taggar: ['KNIVSEGG'],
    });
  };

  test('granskarens kiewindow: en separat flash 2, 4 eller 5 min efter den kända är KANDIDAT', () => {
    const { loadRegistry } = require('../lib/registry');
    const reg = loadRegistry();
    const ctx = { korpus: k42(), rader: [], resultat: {} };
    expect(reg.classify(fasFynd(flash('08:47:00.040', 60), 7), ctx, { räkna: false })).toMatchObject({ klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS' });
    for (const hms of ['08:49:00.040', '08:51:00.040', '08:52:00.040']) {
      const c = reg.classify(fasFynd(flash(hms, 60), 7), ctx, { räkna: false });
      expect(c.klass).toBe('KANDIDAT');
      // Sedan runda 2 (E3) vidgar utslagets egen längd aldrig fönstret: |δ| + en tick.
      expect(c.närmast.skäl).toMatch(/\|δ\| 7 s \+ en tick 30 s \(en annan episod\)/);
    }
  });

  test('i en fasvariant med två flashar förklarar undantaget bara den närmaste', () => {
    const relations = require('../lib/relations');
    const { loadRegistry } = require('../lib/registry');
    const korpus = k42();
    const V = {
      ...clone(TOMT),
      // Den andra flashen ligger 35 s från undantaget, inom |δ| 7 s + en tick 30 s (runda 2, E3).
      bridgeTextTransitions: [
        ['08:40:00.040', en(9)], ['08:46:30.040', INGA], ['08:47:30.040', en(8)], ['08:47:35.040', INGA], ['08:48:35.040', en(7)], ['08:55:00.040', INGA],
      ].map(([hms, text]) => ({ t: at(hms), iso: `2026-08-06T${hms}Z`, text })),
    };
    const base = {
      korpus,
      kc: {
        id: korpus.id, rader: [], simTimmar: 42, jsonl: '/finns/inte/bas.jsonl', statePath: null,
      },
      resultat: clone(TOMT),
      gt: [],
      fatala: [...korpus.knownInvariantExceptions],
      leverans: [],
    };
    const fynd = relations.comparePhase(base, {
      ok: true, resultat: V, stderr: { h3: {}, exempel: {} }, ms: 1,
    }, {
      deltaS: -7, monitoring: false, fil: { jsonl: '/finns/inte/variant.jsonl', statePath: null }, h3Baslinje: { signaturer: {}, timmar: 42 },
    }).filter((f) => f.inv === 'INV-14');
    expect(fynd.map((f) => f.detalj)).toEqual([flash('08:46:30.040', 60), flash('08:47:35.040', 60)]);
    // Båda flasharna är syskon till varandra.
    expect(fynd[1].belägg.syskon).toEqual([flash('08:47:35.040', 60), flash('08:46:30.040', 60)]);
    const reg = loadRegistry();
    const [känd, ny] = fynd.map((f) => reg.classify(f, f.kontext, { räkna: false }));
    expect(känd).toMatchObject({ klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS' });
    // 35 s från undantaget, inom |δ| 7 s + en tick 30 s, men den kända flashen ligger närmare (30 s).
    expect(ny.klass).toBe('KANDIDAT');
    expect(ny.närmast.post).toBe('KIE-PER-KORPUS');
    expect(ny.närmast.skäl).toMatch(/förklarar variantens närmare utslag .*30 s från undantaget mot 35 s; ett undantag förklarar högst en träff per variant/);
  });
});

// ---------------------------------------------------------------------------
// hunt:repro för S-KALIBRERING
// ---------------------------------------------------------------------------

describe('hunt:repro för S-KALIBRERING: bara oregistrerade träffar håller kortet kvar', () => {
  test('bara registrerade träffar ger BORTA och visas som information; en oregistrerad ger KVAR', async () => {
    const synth = require('../lib/lanes/synth');
    const { loadRegistry } = require('../lib/registry');
    const bankOps = require('../lib/bankOps');
    const korpus = bankOps.corpusList(['20260611-4h'])[0];
    const dir = path.join(tmp, 'S01');
    fs.mkdirSync(dir);
    copyFile(fs, korpus.jsonl, path.join(dir, 'bas.jsonl'));
    const sparat = { mekanism: 'T1|NOTIS-UTEBLIVEN' };
    const recept = { korpus: korpus.id, relation: 'S-KALIBRERING', orakel: 'T1' };
    // Ett register där varje T1 NOTIS-UTEBLIVEN är ett känt utfall (som i 42h, där alla åtta är registrerade).
    const känt = loadRegistry({
      version: 1,
      poster: [{
        id: 'TEST-KÄND-T1',
        klass: 'DESIGN',
        datum: '2026-11-04',
        källa: 'docs/BUGGJAKT.md §15',
        gäller: { orakel: ['T1'], klassRegex: '^NOTIS-UTEBLIVEN$' },
        predikat: { namn: 'alltid' },
        regel: 'testpost',
      }],
    });
    const körning = (register) => ({ pool: fakePool(TOMT), register, temp: tmp });
    const borta = await fånga(() => synth.reproKalibrering(dir, körning(känt), { sparat, recept }));
    expect(borta.code).toBe(0);
    expect(borta.text).toMatch(/utfall mot aktuell HEAD: BORTA \(0 oregistrerade utslag av mekanismen; [1-9]\d* registrerade, som information — TEST-KÄND-T1 [1-9]\d*\)/);
    expect(borta.text).toMatch(/- T1 NOTIS-UTEBLIVEN \[DESIGN TEST-KÄND-T1\]/);
    const kvar = await fånga(() => synth.reproKalibrering(dir, körning(loadRegistry()), { sparat, recept }));
    expect(kvar.code).toBe(0);
    expect(kvar.text).toMatch(/utfall mot aktuell HEAD: KVAR \([1-9]\d* oregistrerade utslag av mekanismen; 0 registrerade, som information\)/);
  });
});

// ---------------------------------------------------------------------------
// Låsta bankens LEV- och H1-träffar: närmast och repro
// ---------------------------------------------------------------------------

describe('låsta bankens LEV- och H1-träffar', () => {
  const LEV = 'ÖPPNINGSLEVERANS: 1 avfyrningar, 0 kort, 0 redovisade dubbletter';

  /** Körningen med en baspost för 20260611-4h: en LEV-, en H1- och två INV-F-träffar. */
  function låstaFynd() {
    const selftest = require('../lib/selftest');
    const { loadRegistry } = require('../lib/registry');
    const bankOps = require('../lib/bankOps');
    const korpus = bankOps.corpusList(['20260611-4h'])[0];
    const kc = bankOps.readCorpus(korpus);
    const körning = {
      register: loadRegistry(),
      bas: new Map([[korpus.id, {
        korpus,
        kc,
        resultat: { ...clone(TOMT), processErrors: 1 },
        gt: [],
        utfall: { ok: true, resultat: { ...clone(TOMT), processErrors: 1 } },
        fatala: [
          'DEFAULT-FLASH: 2026-06-11T10:00:00.040Z "Inga båtar" inklämd (30s) mellan två "En … Klaffbron"-texter utan passage',
          'MISSAD MÅLBRO-NOTIS: 2026-06-11T10:05:00.000Z 265000001 Klaffbron',
        ],
        leverans: [LEV],
      }]]),
    };
    return { korpus, fynd: selftest.lockedBankFindings(körning).fynd };
  }

  test('"närmast KIE-PER-KORPUS" bara för INV-F-träffar av de klasser posten gäller', () => {
    const { fynd } = låstaFynd();
    const närmast = fromEntries(fynd.map((f) => [`${f.orakel} ${f.inv || ''}`.trim(), f.register.närmast && f.register.närmast.post]));
    expect(närmast).toEqual({
      'INV-F INV-14': 'KIE-PER-KORPUS', 'INV-F INV-5': null, LEV: null, H1: null,
    });
    for (const f of fynd) expect(f.register.klass).toBe('KANDIDAT');
  });

  test('LEV- och H1-korten bär basens jsonl och receptet BAS, och hunt:repro dömer dem', async () => {
    const hunt = require('../hunt');
    const { mechanismOf } = require('../lib/finding');
    const { korpus, fynd } = låstaFynd();
    const kort = (f) => {
      const dir = path.join(tmp, `${f.orakel}-kort`);
      fs.mkdirSync(dir);
      for (const x of f.repro.filer) copyFile(fs, x.från, path.join(dir, x.till));
      fs.writeFileSync(path.join(dir, 'recept.json'), `${JSON.stringify(f.repro.recept)}\n`);
      fs.writeFileSync(path.join(dir, 'fynd.json'), `${JSON.stringify({ mekanism: mechanismOf(f), fynd: [] })}\n`);
      return dir;
    };
    const lev = fynd.find((f) => f.orakel === 'LEV');
    const h1 = fynd.find((f) => f.orakel === 'H1');
    for (const f of [lev, h1]) {
      expect(f.repro.recept).toMatchObject({ korpus: korpus.id, relation: 'BAS' });
      expect(f.repro.filer.map((x) => x.till)).toContain('bas.jsonl');
    }
    const repro = (dir, resultat) => fånga(() => hunt.runRepro(hunt.parseArgs(['--repro', dir]).flaggor, [], { pool: fakePool(resultat) }));
    const levDir = kort(lev);
    const levKvar = await repro(levDir, { ...clone(TOMT), openingServiceFires: 1 });
    expect(levKvar.code).toBe(0);
    expect(levKvar.text).toMatch(/: KVAR för LEV\|ÖPPNINGSLEVERANS — befintliga domare/);
    expect((await repro(levDir, TOMT)).text).toMatch(/: BORTA för LEV\|ÖPPNINGSLEVERANS/);
    const h1Dir = kort(h1);
    const h1Kvar = await repro(h1Dir, { ...clone(TOMT), processErrors: 1 });
    expect(h1Kvar.code).toBe(0);
    expect(h1Kvar.text).toMatch(/: KVAR för H1\|PROCESSFEL processErrors — hälsooraklen/);
    expect((await repro(h1Dir, TOMT)).text).toMatch(/: BORTA för H1\|PROCESSFEL processErrors/);
  });
});

// ---------------------------------------------------------------------------
// T10 (b): en korsning förklarar högst en registrering per slag
// ---------------------------------------------------------------------------

describe('T10 (b): en andra registrering av samma korsning är en dubblett', () => {
  const MMSI = '265000402';
  let värld = null;
  /** Granskarens kvarliggare (byggs en gång; ren data): söderut genom Stridsbergsbron, stopp 40 m bortom linjen i 30 min (R0). */
  const kvarliggare = () => {
    if (!värld) värld = bygg();
    return värld;
  };
  function bygg() {
    const geo = require('../lib/geo');
    const { deepFreeze } = require('../lib/rng');
    const { simulateWorld } = require('../lib/world');
    const { observeWorld } = require('../lib/radio');
    const { worldTruth } = require('../lib/truth');
    const S = geo.stationByName.Stridsbergsbron.s;
    const boat = {
      mmsi: MMSI,
      name: 'DRÖJ',
      cls: 'A',
      role: 'transit',
      dir: 'south',
      tStartS: 60,
      sStart: S + 900,
      sEnd: S - 1500,
      cruiseKn: 4.6,
      laneM: 0,
      queueLaneM: 0,
      lateralSigma: 0,
      plan: [{ op: 'stop', atS: S - 40, durS: 1800 }],
      tags: [],
      seed: 7,
    };
    const sim = simulateWorld(deepFreeze({
      version: 1, seed: 402, startMs: Date.UTC(2026, 7, 29, 10, 0, 0), durS: 3 * 3600, era: 'aisstream', boats: [boat], events: [], radioSeed: 402,
    }));
    const { rows } = observeWorld(sim, { profile: 'R0' });
    const truth = worldTruth(sim, rows);
    const x = truth.L0.crossings.find((c) => c.bridge === 'Stridsbergsbron');
    return { rows, truth, x };
  }
  // Appens registreringar har hela millisekunder (L0:s korsningstid har det inte).
  const reg = (t, bridge = 'Stridsbergsbron') => ({
    t: Math.round(t), iso: new Date(Math.round(t)).toISOString(), mmsi: MMSI, bridge,
  });
  const fantomer = (r) => r.fynd.filter((f) => f.klass.startsWith('FANTOMPASSAGE') && f.bro === 'Stridsbergsbron');
  const döm = (w, targetPassages, intermediatePassages = [], truth = w.truth) => {
    const { judgeT10 } = require('../lib/oracles/t10Passage');
    return judgeT10({ result: { targetPassages, intermediatePassages }, rows: w.rows, truth });
  };

  test('fixturen: båten ligger kvar inom 70 m-bandet, så kopplingsfönstret varar tills den lämnar det', () => {
    const { matchWindow } = require('../lib/oracles/t10Passage');
    const w = kvarliggare();
    const kw = matchWindow(w.truth.L1.fixes.get(MMSI), w.x);
    expect(kw.grund).toBe('första fix > 70 m bortom linjen');
    expect(kw.till - w.x.t).toBeGreaterThan(30 * MIN);
  });

  test('granskarens fall: registreringar +1 och +20 min — den andra är en dubblett', () => {
    const w = kvarliggare();
    const f = fantomer(döm(w, [reg(w.x.t + MIN), reg(w.x.t + 20 * MIN)]));
    expect(f.map((x) => [x.klass, x.t])).toEqual([['FANTOMPASSAGE(target)', Math.round(w.x.t + 20 * MIN)]]);
    expect(f[0].detalj).toMatch(/dubblett: korsningen 10:06:39 syd har kopplingsfönstret 10:03:39–10:43:15 \(första fix > 70 m bortom linjen 10:38:15\) och är redan registrerad 10:07:39 \(target\)/);
    expect(f[0].belägg.närmasteKorsning).toMatchObject({ dubblett: true, redanRegistrerad: [{ t: new Date(Math.round(w.x.t + MIN)).toISOString(), slag: 'target' }] });
  });

  test('en enda registrering är förklarad var den än ligger i fönstret, och slagen kopplas var för sig', () => {
    const w = kvarliggare();
    expect(fantomer(döm(w, [reg(w.x.t + 20 * MIN)]))).toEqual([]);
    expect(fantomer(döm(w, [reg(w.x.t + 6000)]))).toEqual([]);
    // En målbro bokförd som mellanbro och som målbro (INV-13:s självläkta par) är T10-tyst.
    expect(fantomer(döm(w, [reg(w.x.t + 6000)], [reg(w.x.t + 6000)]))).toEqual([]);
  });

  test('två korsningar förklarar två registreringar (girig koppling), men inte tre', () => {
    const w = kvarliggare();
    // En andra korsning 10 min efter den första (till exempel en vändning under bron).
    const x2 = { ...w.x, t: w.x.t + 10 * MIN };
    const truth = { ...w.truth, L0: { ...w.truth.L0, crossings: [w.x, x2] } };
    // +1 min ryms bara i den första korsningens fönster, +20 min i båda.
    expect(fantomer(döm(w, [reg(w.x.t + MIN), reg(w.x.t + 20 * MIN)], [], truth))).toEqual([]);
    const tre = fantomer(döm(w, [reg(w.x.t + MIN), reg(w.x.t + 20 * MIN), reg(w.x.t + 25 * MIN)], [], truth));
    expect(tre.map((x) => x.t)).toEqual([Math.round(w.x.t + 25 * MIN)]);
    expect(tre[0].belägg.närmasteKorsning.dubblett).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FANTOMPASSAGE-kortets rubrik och orakeltext
// ---------------------------------------------------------------------------

describe('FANTOMPASSAGE-kortet säger att ingen sann korsning förklarar registreringen', () => {
  test('rubrik och orakeltext täcker sena registreringar och dubbletter', () => {
    const report = require('../lib/report');
    require('../lib/lanes/synth'); // registrerar sanningsspårets orakeltexter
    const kluster = (slag) => ({
      orakel: 'T10', klass: `FANTOMPASSAGE(${slag})`, fördelning: { bro: { Stridsbergsbron: 1 }, riktning: {}, spår: { synth: 1 } }, fynd: [],
    });
    expect(report.headlineOf(kluster('target'))).toBe('Registrerad målbropassage som ingen sann korsning förklarar vid Stridsbergsbron');
    expect(report.headlineOf(kluster('intermediate'))).toBe('Registrerad mellanbropassage som ingen sann korsning förklarar vid Stridsbergsbron');
    expect(report.ORAKEL_TEXT.T10).toMatch(/varje registrerad passage ska förklaras av en sann korsning i dess kopplingsfönster \(en korsning förklarar högst en registrering per slag\)/);
  });
});

// ---------------------------------------------------------------------------
// --out med körningens egen logg i katalogen
// ---------------------------------------------------------------------------

describe('--out: loggfiler (*.log) i utkatalogen godtas och lämnas orörda', () => {
  function bankfynd() {
    const { makeFinding } = require('../lib/finding');
    return makeFinding({
      orakel: 'M-FAS',
      klass: 'ÖPPNINGSNYCKEL TILLAGD',
      allvar: 4,
      mmsi: '265552100',
      bro: 'Klaffbron',
      riktning: 'northbound',
      t: Date.parse('2026-07-10T08:35:12.000Z'),
      detalj: 'varianten har en öppningsvarning Klaffbron northbound som basen saknar',
      spår: 'bank',
      nivå: 'bank',
      ursprung: { korpus: '20260710-13h', relation: 'M-FAS', deltaS: [-11.52] },
      taggar: ['KNIVSEGG'],
      repro: { filer: [], kommandon: ['npm run hunt:repro -- <fynd>'], recept: { korpus: '20260710-13h', relation: 'M-FAS', deltaS: -11.52 } },
      register: { klass: 'KANDIDAT', post: null, närmast: null },
    });
  }
  function körningMed(fynd, dir) {
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
      ut: { dir, bas: null, källa: 'flagga' },
    };
  }

  test('tee-fallet och en tidigare körning med sin logg; annat innehåll vägras fortfarande', () => {
    const hygiene = require('../lib/hygiene');
    const report = require('../lib/report');
    const fmt = { format: report.FORMAT };
    // `hunt.js --out=X 2>&1 | tee X/hunt.log`: loggen finns innan motorn startar.
    const ut = path.join(tmp, 'ut');
    fs.mkdirSync(ut);
    fs.writeFileSync(path.join(ut, 'hunt.log'), 'Buggjägaren 1.0.0\n');
    expect(hygiene.checkOutDir(ut, fmt)).toEqual({ ok: true, tidigare: false, fel: null });
    const första = report.writeReport(körningMed([bankfynd()], ut));
    expect(första.kort).toHaveLength(1);
    // Nästa körning i samma katalog: den tidigare körningen ersätts, loggarna ligger kvar.
    fs.writeFileSync(path.join(ut, 'andra.log'), 'andra körningen\n');
    expect(hygiene.checkOutDir(ut, fmt)).toEqual({ ok: true, tidigare: true, fel: null });
    report.writeReport(körningMed([], ut));
    expect(fs.readdirSync(ut).sort()).toEqual(['andra.log', 'hunt.log', 'rapport.json', 'rapport.md']);
    expect(fs.readFileSync(path.join(ut, 'hunt.log'), 'utf8')).toBe('Buggjägaren 1.0.0\n');
    // En katalog som heter *.log är ingen loggfil, och en loggfil gör inte en främmande katalog godtagbar.
    const kat = path.join(tmp, 'kat');
    fs.mkdirSync(path.join(kat, 'gammal.log'), { recursive: true });
    expect(hygiene.checkOutDir(kat, fmt).ok).toBe(false);
    const ägarens = path.join(tmp, 'ägarens');
    fs.mkdirSync(ägarens);
    fs.writeFileSync(path.join(ägarens, 'hunt.log'), 'x\n');
    fs.writeFileSync(path.join(ägarens, 'anteckningar.txt'), 'viktigt\n');
    const c = hygiene.checkOutDir(ägarens, fmt);
    expect(c.ok).toBe(false);
    expect(c.fel).toMatch(/inte tom och saknar en rapport\.json/);
  });
});

// ---------------------------------------------------------------------------
// lib/synthLane.js med relativ --tmp
// ---------------------------------------------------------------------------

describe('lib/synthLane.js: en relativ --tmp görs absolut', () => {
  test('barnet får absolut jsonl, cwd och TMPDIR, och ingen värld fallerar', async () => {
    const cp = require('child_process');
    const anrop = [];
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      // Som operativsystemet: barnets cwd tolkas mot förälderns, och barnet
      // tolkar jsonl-sökvägen mot sin egen cwd.
      const cwd = path.resolve(opts.cwd || '.');
      const jsonl = path.resolve(cwd, args[1]);
      anrop.push({ args, opts });
      const svar = fs.existsSync(jsonl)
        ? JSON.stringify(TOMT)
        : JSON.stringify({ fatal: `ENOENT: no such file or directory, open '${args[1]}'` });
      cb(null, `__REPLAY_JSON__${svar}__END__`, '');
      return {};
    });
    const sl = require('../lib/synthLane');
    const abs = path.join(tmp, 'reltmp');
    const rel = path.relative(process.cwd(), abs);
    expect(path.isAbsolute(rel)).toBe(false);
    const ut = await fånga(() => sl.main(['node', 'synthLane.js', '--worlds=1', '--jobs=1', `--tmp=${rel}`]));
    expect(ut.text).toMatch(/^Fel\/häng: 0$/m);
    expect(anrop).toHaveLength(1);
    for (const a of anrop) {
      expect(path.isAbsolute(a.args[1])).toBe(true);
      expect(path.dirname(a.args[1])).toBe(abs);
      expect(a.opts.cwd).toBe(abs);
      expect(a.opts.env.TMPDIR).toBe(abs);
    }
    // En katalog som anges med --tmp är anroparens och raderas inte.
    expect(ut.text).toMatch(new RegExp(`Filer: ${abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(--tmp, raderas inte\\)`));
    expect(fs.readdirSync(abs).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Körarens punkter: bitlika resultatfiler och R0-bekräftelsens räkning
// ---------------------------------------------------------------------------

describe('körarens punkter', () => {
  test('repro.result.json saknar heapUsedMB, så fynd/ blir bitlikt mellan körningar', () => {
    const synth = require('../lib/lanes/synth');
    const utfall = (heap) => ({ resultat: { ...clone(TOMT), jsonl: '/tmp/x/w1-0-R1.jsonl', leakDiagnostics: { vessels: 0, heapUsedMB: heap } } });
    const a = synth.resultatFörFil(utfall(41));
    expect(a).toMatchObject({ jsonl: 'repro.jsonl', leakDiagnostics: { vessels: 0 } });
    expect(a.leakDiagnostics).not.toHaveProperty('heapUsedMB');
    expect(JSON.stringify(a)).toBe(JSON.stringify(synth.resultatFörFil(utfall(57))));
    expect(synth.resultatFörFil({ resultat: null, fel: 'körfel' })).toEqual({ fel: 'körfel' });
  });

  test('ett stressfynd som reproducerar med R0 räknas inte som R1-fynd i sammanfattningen', () => {
    const synth = require('../lib/lanes/synth');
    // Bekräftade representanter (R1-radio) som alla reproducerar med R0.
    const jobb = (nivå, radio = 'R1') => ({
      f: {
        nivå,
        bekräftelse: {
          instrumentfel: null, knivsegg: false, r0Bekräftad: true, steg: {},
        },
        repro: { krympt: true, recept: { radio, prov: 3 } },
      },
    });
    const t = synth.krympningsTäckning([jobb('R1'), jobb('stress'), jobb('stress'), jobb('R0', 'R0')]);
    expect(t).toMatchObject({
      representanter: 4, krympta: 4, r0Bekräftade: 1, r0BekräftadeStress: 2, prov: 12, nödbroms: 0, obekräftade: 0,
    });
    const körning = {
      kluster: [],
      fynd: [],
      täckning: {
        synt: {
          världar: 2, budget: 2, perProfil: { R1: 2 }, perNivå: { stress: 1 }, simTimmar: 6,
        },
        krympning: t,
      },
    };
    const text = synth.sammanfattning(körning);
    expect(text).toMatch(/4 av 4 representanter krympta och bekräftade, 1 R1-fynd reproducerar med R0 \(flyttade till logikfel\), /);
    expect(text).toMatch(/, 2 stressfynd med R1-radio reproducerar med R0 \(stannar under Stress\)/);
  });
});
