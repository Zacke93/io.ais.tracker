'use strict';

/**
 * Rättningsrundan 2026-11-04, M09: nödbromsen --max-minutes i fas 4 märker
 * rapporten AVKORTAD — när ett jobb aldrig hinner starta (obekräftat), när en
 * krympbudget bromsas (repron blir "delvis krympt" efter väggklockan) och när
 * tiden redan är slut före fasen — och sammanfattningen säger det.
 *
 * Replay ersätts av en injicerad pool; världen är en kanariespec (en båt,
 * några ms per simulering). Inga barnprocesser och inga timers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-avkortad-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** En pool vars barn alltid fallerar utan resultat (ger H1 PROCESSFEL inget resultat). */
function fallerandePool() {
  return {
    jobb: 1,
    statistik: {},
    async run(job) {
      return {
        etikett: job.etikett,
        jsonl: job.jsonl,
        ok: false,
        häng: false,
        fatal: null,
        fel: 'konstruerat körfel',
        försök: [],
        ms: 1,
        rader: job.rader,
        simTimmar: job.simTimmar,
        resultat: null,
        stderr: {
          h3: {}, övrigt: {}, rader: 0, exempel: {},
        },
      };
    },
  };
}

/**
 * Ett syntetiskt kandidatkluster vars representant pekar på en sparad värld
 * (kanarie K1 med sidledsbrus, så att krympningens steg C har något att pröva).
 */
function körningMed({ tidenUte, pool = { jobb: 2 }, specFinns = true }) {
  const core = require('../lib/synthCore');
  const st = require('../lib/selftestSynth');
  const { makeFinding } = require('../lib/finding');
  const { clusterFindings } = require('../lib/cluster');
  const { loadRegistry } = require('../lib/registry');
  const { getProfile } = require('../lib/profiles');
  const spec = JSON.parse(JSON.stringify(st.loadCanaries()[0].spec));
  spec.boats[0].lateralSigma = 4;
  const specPath = path.join(tmp, 'w-repro.spec.json');
  if (specFinns) fs.writeFileSync(specPath, core.specFileContent(core.materialize(spec, { profile: 'R0' }), { monitoring: false }));
  const f = makeFinding({
    orakel: 'H1',
    klass: 'PROCESSFEL inget resultat',
    allvar: 10,
    detalj: 'konstruerat körfel',
    spår: 'synth',
    nivå: 'R0',
    ursprung: {
      värld: 0, radio: 'R0', familj: spec.familj, båtar: 1, timmar: 3,
    },
    register: { klass: 'KANDIDAT', post: null, närmast: null },
  });
  f.repro = {
    filer: [{ från: specPath, till: 'repro.spec.json' }],
    kommandon: [],
    recept: {
      spår: 'synth', värld: 0, radio: 'R0', krympt: false, mål: core.targetOf(f),
    },
    underlag: 'hela världen (ej krympt).',
    krympt: false,
  };
  return {
    motorversion: 'test',
    git: {
      före: {
        finns: false, sha: null, sha7: 'nogit', ändrat: null,
      },
    },
    flaggor: { maxMinuter: 0.15 },
    profil: getProfile('quick'),
    seed: 1,
    spår: ['synth'],
    korpusar: [],
    körningsId: 'abc',
    temp: tmp,
    pool,
    register: loadRegistry(),
    hälsa: { självtest: { status: 'EJ KÖRT', text: '' }, varningar: [] },
    sammanfattning: [],
    fynd: [f],
    kluster: clusterFindings([f]),
    täckning: {
      rader: [],
      synt: {
        världar: 1, budget: 1, perProfil: { R0: 1 }, perNivå: { R0: 1 }, simTimmar: 3,
      },
    },
    tid: {},
    avkortad: false,
    avkortning: [],
    tidenUte,
  };
}

describe('M09: nödbromsen i fas 4 märker rapporten AVKORTAD', () => {
  test('ett jobb som aldrig hinner starta: AVKORTAD, obekräftat, och titeln och sammanfattningen säger det', async () => {
    const synth = require('../lib/lanes/synth');
    const report = require('../lib/report');
    const k = körningMed({ tidenUte: () => true, specFinns: false });
    await synth.krympAlla(k, { n: 5, perKluster: 1, krymp: true });
    expect(k.avkortad).toBe(true);
    expect(k.avkortning).toEqual(['fas 4 (krympning och bekräftelse): 1 av 1 obekräftade']);
    expect(k.täckning.krympning).toMatchObject({ representanter: 1, krympta: 0, obekräftade: 1 });
    expect(k.kluster[0].fynd[0].repro.bekräftelse).toMatch(/nödbromsen/);
    expect(synth.sammanfattning(k)).toMatch(/0 av 1 representanter krympta och bekräftade; AVKORTAD av nödbromsen i fas 4: 1 obekräftade/);
    expect(report.renderReportMd(k, report.assignCards(k.kluster))).toMatch(/^# Buggjägarens rapport — quick, seed 1 \(AVKORTAD\)/);
    expect(report.buildReportJson(k, report.assignCards(k.kluster)).körning).toMatchObject({ avkortad: true, avkortning: k.avkortning });
  });

  test('en krympbudget som bromsas av nödbromsen ger delvis krympt repro och AVKORTAD', async () => {
    const synth = require('../lib/lanes/synth');
    // Första frågan (poolen tar jobbet) är nej; därefter är tiden slut, så
    // budgeten bromsas redan i krympningens första steg.
    let frågor = 0;
    const k = körningMed({ tidenUte: () => ++frågor > 1, pool: fallerandePool() });
    await synth.krympAlla(k, { n: 5, perKluster: 1, krymp: true });
    const f = k.kluster[0].fynd[0];
    expect(f.repro.krympt).toBe(true);
    expect(f.repro.underlag).toMatch(/delvis krympt \(nödbromsen \(--max-minutes\)\)/);
    expect(k.täckning.krympning).toMatchObject({ representanter: 1, nödbroms: 1, obekräftade: 0 });
    expect(k.avkortad).toBe(true);
    expect(k.avkortning).toEqual(['fas 4 (krympning och bekräftelse): 1 av 1 representanter delvis krympta av nödbromsen']);
    expect(synth.sammanfattning(k)).toMatch(/AVKORTAD av nödbromsen i fas 4: 1 delvis krympta av nödbromsen/);
  });

  test('utan nödbroms eller utan krympning märks ingenting; när tiden var slut före fasen hoppas krympningen över', async () => {
    const synth = require('../lib/lanes/synth');
    const lugn = körningMed({ tidenUte: () => false, specFinns: false });
    await synth.krympAlla(lugn, { n: 5, perKluster: 1, krymp: false });
    expect(lugn.avkortad).toBe(false);
    expect(lugn.täckning.krympning).toEqual({ avstängd: true, representanter: 0, krympta: 0 });
    // --no-shrink: fas 4 gör ingen replay, så en tid som tagit slut påverkar inget.
    const utanKrymp = körningMed({ tidenUte: () => true, specFinns: false });
    await synth.krympAlla(utanKrymp, { n: 5, perKluster: 1, krymp: false });
    expect(utanKrymp.avkortad).toBe(false);
    const sen = körningMed({ tidenUte: () => true, specFinns: false });
    await synth.krympAlla(sen, {
      n: 5, perKluster: 1, krymp: false, nödbroms: true,
    });
    expect(sen.täckning.krympning.hoppadesÖver).toBe('nödbromsen (--max-minutes)');
    expect(synth.sammanfattning(sen)).toMatch(/krympningen hoppades över \(nödbromsen \(--max-minutes\); AVKORTAD\)/);
  });

  test('sammanfattningen får en första rad om avkortningen', () => {
    const { summarize } = require('../hunt');
    const k = {
      hälsa: { självtest: { status: 'GRÖNT', text: 'determinism 24/24' } },
      täckning: { saknadeSpår: [] },
      flaggor: { maxMinuter: 0.15 },
      avkortad: true,
      avkortning: ['fas 4 (krympning och bekräftelse): 2 av 4 representanter delvis krympta av nödbromsen'],
    };
    summarize(k, []);
    expect(k.sammanfattning[0]).toBe('AVKORTAD av nödbromsen (--max-minutes=0,15): fas 4 (krympning och bekräftelse): '
      + '2 av 4 representanter delvis krympta av nödbromsen. Rapporten beror på väggklockan och är inte reproducerbar.');
    expect(k.sammanfattning[1]).toMatch(/^Självtest: GRÖNT/);
  });
});
