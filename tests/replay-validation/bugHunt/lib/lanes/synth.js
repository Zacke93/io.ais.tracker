'use strict';

/**
 * Sanningsspåret i motorn (BUGGJAKT §4): världar med facit.
 *
 * Fas 0, självtesttillägg (körs efter bankens självtest):
 *   S-KANARIE      fem R0-kanarier: instrumentkrav (brott ⇒ INSTRUMENT BLINT,
 *                  exit 2) och produktförväntningar (brott ⇒ KANARIE-kort först
 *                  i rapporten)
 *   S-RUNDRESA     spec → JSON → rader två gånger, bitlikt (20 världar × R0/R1
 *                  plus kanarierna); en avvikelse stoppar
 *   S-KALIBRERING  T1 och T10 på bankens basresultat; varje träff klassas av
 *                  registret. En oregistrerad träff blir ett kort på låst bank,
 *                  och oraklet märks okalibrerat (dess syntetiska utslag blir
 *                  räknare i körningen)
 *   S-REALISM      realismtabellen för R1 mäts och redovisas (grinden stoppar
 *                  inte i v1; R1 redovisas som robusthet)
 * Fas 2: budgeten i ANTAL världar. Värld i får seed ur (bas-seed, 'värld-i'),
 *   radioprofil ur (bas-seed, 'profil-i') med 30 % R0 och REPLAY_MONITORING=1
 *   för var fjärde värld. Varje värld döms med alla orakel och klassas direkt
 *   av registret (kontexten är för stor att spara för tusentals världar).
 *   Nödbromsen avbryter efter det sammanhängande prefixet av dömda världar
 *   och märker rapporten AVKORTAD.
 * Fas 4: krympning på specnivå och bekräftelse av profilens topp-N
 *   kandidatkluster (och upp till två konfliktkluster). Bromsar nödbromsen en
 *   budget, eller hinner ett jobb inte starta, märks rapporten AVKORTAD.
 * hunt:repro: bygger om världen ur repro.spec.json och dömer på nytt; kort
 *   ur självtesttillägget döms om av reproKalibrering (S-KALIBRERING) och
 *   reproKanarie (S-KANARIE). En körning som fallerar ger KAN INTE DÖMAS.
 */

const fs = require('fs');
const path = require('path');
const core = require('../synthCore');
const shrink = require('../shrink');
const confirm = require('../confirm');
const selftest = require('../selftest');
const selftestSynth = require('../selftestSynth');
const realism = require('../realism');
const calib = require('../calib');
const report = require('../report');
const bankOps = require('../bankOps');
const { FAMILIES, sampleWorld } = require('../families');
const { profileFor } = require('../synthLane');
const { hashJson } = require('../rng');
const { bankTruth, truthToJson } = require('../truth');
const { judgeT1 } = require('../oracles/t1Notice');
const { judgeT10 } = require('../oracles/t10Passage');
const { addCounters } = require('../oracles/truthCommon');
const { namespaceEventIds } = require('../instances');
const { makeFinding, mechanismOf } = require('../finding');
const { mapPool, costModelMs } = require('../pool');
const clusterLib = require('../cluster');
const { fromEntries } = require('../util');
const { MAX_KORT } = require('../profiles');

const RADIOS = Object.freeze(['R0', 'R1']);
const ORAKELGRUPPER = Object.freeze(['T1', 'T2', 'T3', 'T9', 'T10', 'INV-F', 'LEV', 'H1', 'H2', 'H3']);
const MAX_KONFLIKTEXEMPEL = 2;
/** hunt:repro:s exitkod när kortet inte kan dömas (samma som hunt.js). */
const EXIT_KAN_INTE_DÖMAS = 2;

const { fmtNum } = report;

// ---------------------------------------------------------------------------
// Orakeltexter för korten
// ---------------------------------------------------------------------------

report.registerOracleText('T1', 'notis per observerat besök — varje besök inom 300 m som radion visat ska ge en notis i [tIn − 10 min; tOut + 15 min].');
report.registerOracleText('T2', 'öppningsvarning före sann passage — en punktobserverbar målbrokorsning ska vara täckt, med ledtid minst 60 s före den sanna korsningen.');
report.registerOracleText('T3', 'fantomvarning mot avsikt — en varning ska följas av en sann korsning eller ett avbrott som L0 bekräftar.');
report.registerOracleText('T9', 'riktningssanning — en bestämd riktning får inte motsäga L0 under de 180 s före anspråket.');
report.registerOracleText('T10', 'passagedetektion — en beslutsam sann korsning ska registreras, och varje registrerad passage ska förklaras '
  + 'av en sann korsning i dess kopplingsfönster (en korsning förklarar högst en registrering per slag).');
report.registerOracleText('S-KANARIE', 'kanariens produktförväntningar — en ensam båt med exakt känt facit ska få en notis per punkt, två målbropassager och varningar över kanariegolvet.');

// ---------------------------------------------------------------------------
// Flaggor
// ---------------------------------------------------------------------------

function laneOptions(flaggor) {
  const radios = flaggor.radio || [...RADIOS];
  const families = flaggor.familjer || [...FAMILIES];
  return { radios, families };
}

/**
 * Kontrollerar --radio och --families innan något körs (felaktig användning ⇒ exit 1).
 * @param {object} flaggor - tolkade flaggor
 */
function kontrollera(flaggor) {
  const fel = (msg) => Object.assign(new Error(msg), { användning: true });
  const { radios, families } = laneOptions(flaggor);
  for (const r of radios) {
    if (r === 'R2') throw fel('--radio=R2 (adversariell radio) kommer i v1.1 och finns inte i v1');
    if (!RADIOS.includes(r)) throw fel(`okänd radioprofil "${r}" (kända: ${RADIOS.join(', ')})`);
  }
  for (const f of families) {
    if (f === 'F-OMSTART') throw fel('--families=F-OMSTART är sträckmål S1 (kräver T11) och finns inte i v1');
    if (!FAMILIES.includes(f)) throw fel(`okänd familj "${f}" (kända: ${FAMILIES.join(', ')})`);
  }
}

// ---------------------------------------------------------------------------
// Poolen som runReplay för selftestSynth
// ---------------------------------------------------------------------------

function poolRunner(körning) {
  return async (jsonlPath, { monitoring = false } = {}) => {
    const u = await körning.pool.run({ jsonl: jsonlPath, monitoring, etikett: path.basename(jsonlPath) });
    return {
      result: u.ok ? u.resultat : null, stderr: '', ms: u.ms, timedOut: u.häng, error: u.ok ? null : u.fel,
    };
  };
}

// ---------------------------------------------------------------------------
// S-KALIBRERING
// ---------------------------------------------------------------------------

/**
 * S-KALIBRERING för EN korpus: T1 och T10 på basresultatet mot banksanningen
 * (rådatafacit som L1 och besöken som var öppna i starttillståndet), och
 * varje träff klassad av registret. Delas av självtestet (kalibrera) och
 * hunt:repro (reproKalibrering), så att ett kalibreringskort döms om exakt
 * som det skapades.
 * @param {object} register - registret
 * @param {object} b - baspost (selftest.baseEntry): {korpus, kc, resultat, gt}
 * @param {{räkna?: boolean}} [opts] - räkna=false: registrets användning bokförs inte
 * @returns {{t1: object, t10: object, fynd: object[]}} domen (fynden klassade)
 */
function kalibreraKorpus(register, b, { räkna = true } = {}) {
  const c = b.korpus;
  const truth = bankTruth(c.id, b.kc.rader, { statePath: b.kc.statePath || null });
  const ctx = { result: b.resultat, rows: b.kc.rader, truth };
  const t1 = judgeT1(ctx);
  const t10 = judgeT10(ctx);
  const rctx = {
    rader: b.kc.rader, resultat: b.resultat, gt: b.gt, korpus: b.korpus, öppnaBesök: truth.L1.openVisitsAtStart,
  };
  const fynd = [...t1.fynd, ...t10.fynd].map((raw) => {
    const f = makeFinding({
      ...raw,
      belägg: core.registryAliases(raw),
      spår: 'självtest',
      nivå: 'bank',
      ursprung: {
        korpus: c.id, relation: 'S-KALIBRERING', rader: b.kc.rader.length, timmar: b.kc.simTimmar,
      },
    });
    const cl = register.classify(f, rctx, { räkna });
    f.register = {
      klass: cl.klass, post: cl.post, närmast: cl.närmast, skäl: cl.skäl, prövade: (cl.prövade || []).slice(0, 4),
    };
    return f;
  });
  return { t1, t10, fynd };
}

/**
 * T1 och T10 på bankens basresultat. Varje träff klassas av registret; en
 * oregistrerad träff blir ett kort på låst bank och märker oraklet okalibrerat.
 * @param {object} körning - körningsobjektet
 * @param {{avSpåret?: boolean}} [opts] - körd av spåret (självtestet ingick inte)
 * @returns {Promise<object>} hälsa.kalibrering
 */
async function kalibrera(körning, { avSpåret = false } = {}) {
  if (!körning.bas) await selftest.ensureBase(körning);
  const reg = körning.register;
  const tabell = {
    T1: {
      besök: 0, bedömda: 0, utslag: 0, registrerade: 0, poster: {},
    },
    T10: {
      appPassager: 0, beslutsammaKorsningar: 0, utslag: 0, registrerade: 0, poster: {},
    },
  };
  const fynd = [];
  const oregistrerade = [];
  for (const c of körning.korpusar) {
    const b = körning.bas.get(c.id);
    if (!b || !b.resultat) continue;
    const { t1, t10, fynd: dömda } = kalibreraKorpus(reg, b);
    tabell.T1.besök += t1.räknare.besök;
    tabell.T1.bedömda += t1.räknare.bedömda;
    tabell.T10.appPassager += t10.räknare.appPassager;
    tabell.T10.beslutsammaKorsningar += t10.räknare.beslutsammaKorsningar;
    for (const f of dömda) {
      const cl = f.register;
      const rad = tabell[f.orakel];
      rad.utslag++;
      if (cl.klass === 'KANDIDAT') {
        f.taggar = [...new Set([...f.taggar, 'LÅST-BANK'])].sort();
        f.repro = {
          filer: [{ från: b.kc.jsonl, till: 'bas.jsonl' }, ...(b.kc.statePath ? [{ från: b.kc.statePath, till: 'bas.state.json' }] : [])],
          kommandon: ['node tests/replay-validation/replayRunner.js <fynd>/bas.jsonl', 'npm run hunt:selftest'],
          recept: { korpus: c.id, relation: 'S-KALIBRERING', orakel: f.orakel },
          underlag: `den låsta korpusen ${c.id}, ${b.kc.rader.length} rader (bankkalibreringen; ingen post i registret matchar).`,
          bekräftelse: 'verklig data; basen är byte-identisk mellan två körningar.',
        };
        oregistrerade.push(f);
      } else {
        rad.registrerade++;
        rad.poster[cl.post] = (rad.poster[cl.post] || 0) + 1;
      }
      fynd.push(f);
    }
  }
  const okalibrerade = [...new Set(oregistrerade.map((f) => f.orakel))].sort();
  const posterText = (p) => Object.entries(p).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(', ');
  const rowText = (namn, r, prov) => `${namn}: ${prov}, ${r.utslag} utslag, ${r.registrerade} registrerade${r.utslag ? ` (${posterText(r.poster) || '—'})` : ''}`;
  const text = [
    rowText('T1', tabell.T1, `${tabell.T1.bedömda} bedömda besök av ${tabell.T1.besök}`),
    rowText('T10', tabell.T10, `${tabell.T10.appPassager} app-passager och ${tabell.T10.beslutsammaKorsningar} beslutsamma korsningar`),
  ].join('; ')
    + (okalibrerade.length ? `; OKALIBRERADE: ${okalibrerade.join(', ')} (${oregistrerade.length} oregistrerade träffar; de syntetiska utslagen blir räknare)` : '; 0 oregistrerade träffar')
    + (körning.delmängd ? ' (delmängd)' : '')
    + (avSpåret ? ' — körd av sanningsspåret eftersom självtestet inte ingick' : '');
  körning.hälsa.kalibrering = {
    tabell, okalibrerade, oregistrerade: oregistrerade.length, text,
  };
  körning.fynd.push(...fynd);
  körning.täckning.rader.push(
    {
      spår: 'självtest', orakel: 'S-KALIBRERING T1 (bank)', profil: 'bank', prövat: tabell.T1.bedömda, utslag: oregistrerade.filter((f) => f.orakel === 'T1').length,
    },
    {
      spår: 'självtest',
      orakel: 'S-KALIBRERING T10 (bank)',
      profil: 'bank',
      prövat: tabell.T10.appPassager + tabell.T10.beslutsammaKorsningar,
      utslag: oregistrerade.filter((f) => f.orakel === 'T10').length,
    },
  );
  return körning.hälsa.kalibrering;
}

// ---------------------------------------------------------------------------
// Fas 0: självtesttillägget
// ---------------------------------------------------------------------------

function canaryFindings(k) {
  return k.produkt.filter((p) => !p.ok).map((p) => makeFinding({
    orakel: 'S-KANARIE',
    klass: `PRODUKTFÖRVÄNTAN ${p.namn}`,
    allvar: 6,
    detalj: `kanarien ${k.id}: "${p.namn}" bröts (${JSON.stringify(p.värde).slice(0, 200)})`,
    belägg: { kanarie: k.id, krav: p.namn, värde: p.värde },
    spår: 'självtest',
    nivå: 'R0',
    ursprung: { kanarie: k.id, radio: 'R0', rader: k.rader },
    taggar: ['KANARIE'],
    repro: {
      filer: k.jsonlPath ? [{ från: k.jsonlPath, till: 'repro.jsonl' }] : [],
      kommandon: ['node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl', 'npm run hunt:repro -- <fynd>', 'npm run hunt:selftest'],
      // hunt:repro dömer om kortet med kanariekontrollen (reproKanarie).
      recept: { relation: 'S-KANARIE', kanarie: k.id, krav: p.namn },
      underlag: `kanarien ${k.id} (${k.rader} rader, R0) ur canaries/kanarier.json.`,
      bekräftelse: 'kanarien körs i varje självtest.',
    },
  }));
}

function realismText(tabs) {
  const part = (t) => {
    const m = t.mått[0];
    const ok = t.mått.filter((x) => x.ok50 && x.ok90).length;
    return `${t.era}: ${m.namn} p50/p90 ${fmtNum(m.gen.p50)}/${fmtNum(m.gen.p90)} mot fältets ${fmtNum(m.fält.p50)}/${fmtNum(m.fält.p90)}; `
      + `${ok} av ${t.mått.length} mått inom grinden`;
  };
  const grön = tabs.every((t) => t.grön);
  return `${grön ? 'fältlik — realismgrinden GRÖN' : 'robusthet (okalibrerad i v1) — realismgrinden RÖD'} (${tabs.map(part).join('; ')})`;
}

/**
 * Sanningsspårets självtesttillägg (körs sist i fas 0).
 * @param {object} körning - körningsobjektet
 */
async function självtest(körning) {
  const h = körning.hälsa;
  const dir = path.join(körning.temp, 'synt-självtest');
  fs.mkdirSync(dir, { recursive: true });

  // S-KANARIE
  const kan = await selftestSynth.runCanaries({ runReplay: poolRunner(körning), tmpDir: dir });
  const brutna = (k, lista) => (k[lista] || []).filter((x) => !x.ok).map((x) => x.namn);
  h.kanarier = {
    instrumentOk: kan.instrumentOk,
    produktOk: kan.produktOk,
    kanarier: kan.kanarier.map((k) => ({
      id: k.id,
      instrumentOk: k.instrumentOk,
      produktOk: k.produktOk,
      brutnaInstrument: brutna(k, 'instrument'),
      brutnaProdukt: brutna(k, 'produkt'),
      ledtider: k.ledtider || [],
      info: k.info || [],
      fel: k.fel || null,
    })),
  };
  for (const k of kan.kanarier.filter((x) => !x.instrumentOk)) {
    körning.stoppa(0, `INSTRUMENT BLINT: kanarien ${k.id}: ${k.fel || brutna(k, 'instrument').join(', ')}`);
  }
  for (const k of kan.kanarier.filter((x) => x.instrumentOk && !x.produktOk)) körning.fynd.push(...canaryFindings(k));

  // S-RUNDRESA
  const rt = selftestSynth.roundTrip({ seed: körning.seed, n: 20 });
  const rtK = selftestSynth.roundTrip({ specs: selftestSynth.loadCanaries().map((k) => k.spec), profiles: ['R0'] });
  const avvikelser = [...rt.avvikelser, ...rtK.avvikelser];
  const prövade = rt.prövade + rtK.prövade;
  h.rundresa = { prövade, avvikelser };
  if (avvikelser.length) körning.stoppa(0, `S-RUNDRESA: ${avvikelser.length} av ${prövade} världar gav inte bitlika rader ur sin JSON-spec`);
  const ledtid = kan.kanarier.flatMap((k) => (k.ledtider || []).map((l) => `${k.id} ${l.bro} ${l.ledtidS} s`)).slice(0, 6).join(', ');
  const info = kan.kanarier.filter((k) => (k.info || []).length).map((k) => k.id);
  h.kanarier.text = `${kan.kanarier.filter((k) => k.instrumentOk).length}/${kan.kanarier.length} kanarier med instrumentkraven uppfyllda, `
    + `${kan.kanarier.filter((k) => k.produktOk).length}/${kan.kanarier.length} med produktförväntningarna`
    + `${ledtid ? ` (ledtider ${ledtid})` : ''}${info.length ? `; information (T4 >1, öppen fråga): ${info.join(', ')}` : ''}`
    + `; rundresa ${prövade - avvikelser.length}/${prövade} bitlika`;
  körning.självtestTexter = [...(körning.självtestTexter || []),
    `kanarier ${kan.kanarier.filter((k) => k.instrumentOk).length}/${kan.kanarier.length}`, `rundresa ${prövade - avvikelser.length}/${prövade}`];
  körning.täckning.rader.push(
    {
      spår: 'självtest', orakel: 'S-KANARIE (produktförväntningar)', profil: 'R0', prövat: kan.kanarier.length, utslag: kan.kanarier.filter((k) => !k.produktOk).length,
    },
    {
      spår: 'självtest', orakel: 'S-RUNDRESA', profil: 'R0/R1', prövat: prövade, utslag: avvikelser.length,
    },
  );

  // S-KALIBRERING
  await kalibrera(körning);

  // S-REALISM (mäts och redovisas; stoppar inte i v1)
  const tabs = ['aisstream', 'aishub'].map((era) => realism.measureRealism({ era }));
  h.realism = {
    grön: tabs.every((t) => t.grön),
    text: realismText(tabs),
    tabeller: tabs,
  };

  // Bankens hash mot den frysta kalibreringen.
  if (!körning.delmängd) {
    const bh = calib.checkBankHash();
    if (!bh.ok) h.varningar.push(`banken har ändrats sedan kalibreringen frystes (${bh.ändrade.join(', ') || 'okänd fil'}) — kör om tools/freezeCalibration.js efter granskning`);
  }
}

// ---------------------------------------------------------------------------
// Fas 2: världarna
// ---------------------------------------------------------------------------

/**
 * Replayresultatet som det sparas i kortets repro.result.json: jsonl-fältet
 * pekar på kortets egen fil, och läckagediagnostikens heapUsedMB utesluts.
 * heapUsedMB är replayRunners mätvärde för processens minne; det varierar
 * mellan körningar med samma seed och undantas redan av INV-12, H5 och
 * M-EXAKT. Utan det blir fynd/ bitlikt mellan två körningar (efterrättning D;
 * körarens determinismkontroll fann 6 olika filer i quick och 12 i standard).
 * @param {object} utfall - poolens utfall
 * @returns {object} filens innehåll
 */
function resultatFörFil(utfall) {
  if (!utfall.resultat) return { fel: utfall.fel };
  const out = { ...utfall.resultat, jsonl: 'repro.jsonl' };
  if (out.leakDiagnostics && typeof out.leakDiagnostics === 'object') {
    const läckage = { ...out.leakDiagnostics };
    delete läckage.heapUsedMB;
    out.leakDiagnostics = läckage;
  }
  return out;
}

function reproFor(f, w) {
  const mon = w.monitoring ? 'REPLAY_MONITORING=1 ' : '';
  return {
    filer: [
      { från: w.jsonlPath, till: 'repro.jsonl' },
      { från: w.specPath, till: 'repro.spec.json' },
      { från: w.truthPath, till: 'repro.truth.json' },
      { från: w.resultPath, till: 'repro.result.json' },
    ],
    kommandon: [`${mon}node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl`, 'npm run hunt:repro -- <fynd>'],
    recept: {
      spår: 'synth',
      värld: w.index,
      basSeed: w.basSeed,
      seed: w.seed,
      radio: w.radio,
      monitoring: w.monitoring,
      familj: w.familj,
      radHash: w.radHash,
      krympt: false,
      mål: core.targetOf(f),
    },
    underlag: `hela världen (ej krympt): ${w.beskrivning}.`,
    krympt: false,
  };
}

/**
 * Dömer värld i.
 * @returns {Promise<object>} världsposten
 */
async function judgeWorld(körning, i, { radios, families, dir }) {
  const { seed } = körning;
  const radio = profileFor(seed, i, radios, körning.profil.r0Andel);
  const spec = sampleWorld(seed, i, { families });
  const built = core.materialize(spec, { profile: radio });
  const namn = `w${built.spec.seed}-${i}-${radio}`;
  const monitoring = i % 4 === 3;
  const { utfall, jsonlPath } = await core.runBuilt(körning.pool, built, { dir, namn, monitoring });
  const dom = core.judgeBuilt({
    built,
    utfall,
    jsonlPath,
    register: körning.register,
    h3Baslinje: körning.hälsa.h3Baslinje,
    okalibrerade: (körning.hälsa.kalibrering && körning.hälsa.kalibrering.okalibrerade) || [],
    meta: {
      index: i, radio, monitoring, profil: körning.profil.namn,
    },
  });
  const kort = dom.fynd.filter((f) => !f.räknare);
  if (kort.length) {
    const w = {
      index: i,
      basSeed: seed,
      seed: built.spec.seed,
      radio,
      monitoring,
      familj: built.spec.familj,
      radHash: built.radHash,
      jsonlPath,
      specPath: path.join(dir, `${namn}.spec.json`),
      truthPath: path.join(dir, `${namn}.truth.json`),
      resultPath: path.join(dir, `${namn}.result.json`),
      beskrivning: core.describeWorld(built),
    };
    fs.writeFileSync(w.specPath, core.specFileContent(built, { monitoring }));
    fs.writeFileSync(w.truthPath, `${JSON.stringify(truthToJson(built.truth))}\n`);
    fs.writeFileSync(w.resultPath, `${JSON.stringify(resultatFörFil(utfall))}\n`);
    for (const f of kort) f.repro = reproFor(f, w);
  } else {
    fs.rmSync(jsonlPath, { force: true });
  }
  return {
    index: i,
    radio,
    familj: built.spec.familj,
    nivå: built.density.nivå,
    monitoring,
    båtar: built.spec.boats.length,
    rader: built.rows.length,
    simTimmar: built.simTimmar,
    radHash: built.radHash,
    ok: utfall.ok,
    häng: utfall.häng,
    fel: utfall.ok ? null : utfall.fel,
    fynd: dom.fynd,
    räknare: dom.räknare,
  };
}

function stripPaths(f) {
  const out = { ...f };
  if (out.repro) out.repro = { ...out.repro, filer: (out.repro.filer || []).map((x) => ({ till: x.till })) };
  return out;
}

function addFlatCounters(körning, perRadio) {
  const rk = körning.täckning.räknare;
  for (const [radio, r] of Object.entries(perRadio)) {
    const put = (k, v) => {
      if (Number.isFinite(v) && v > 0) rk[`${k} (synth ${radio})`] = v;
    };
    put('T1 bedömda besök', r.T1 && r.T1.bedömda);
    put('T1 SEN-NOTIS', r.T1 && r.T1['SEN-NOTIS']);
    put('T2 täckta korsningar', r.T2 && r.T2.täckta);
    put('T2 tunn ledtid 60–150 s', r.T2 && r.T2.tunn);
    put('T3 varningar', r.T3 && r.T3.varningar);
    put('T4 grupper med fler än en varning', r.T4 && r.T4.flerÄn1);
    put('T4 grupper utan varning', r.T4 && r.T4.noll);
    put('T9 prövade anspråk', r.T9 && r.T9.prövade);
    put('T10 beslutsamma korsningar', r.T10 && r.T10.beslutsammaKorsningar);
  }
}

/**
 * Fas 2: kör och dömer profilens världar.
 * @param {object} körning - körningsobjektet
 * @returns {Promise<object>} körning
 */
async function kör(körning) {
  const { radios, families } = laneOptions(körning.flaggor);
  if (!körning.bas || !körning.hälsa.h3Baslinje) await selftest.ensureBase(körning);
  if (!körning.hälsa.kalibrering) await kalibrera(körning, { avSpåret: true });
  if (körning.stopp.length && !körning.flaggor.ignoreraSjälvtest) return körning;
  const dir = path.join(körning.temp, 'synt');
  fs.mkdirSync(dir, { recursive: true });
  const N = körning.världar;
  const indices = Array.from({ length: N }, (_, i) => i);
  const recs = await mapPool(indices, körning.pool.jobb, (i) => judgeWorld(körning, i, { radios, families, dir }), körning.tidenUte);
  let prefix = recs.findIndex((r) => r === undefined);
  if (prefix < 0) prefix = recs.length;
  else report.markeraAvkortad(körning, `fas 2 (sanningsspåret): ${prefix} av ${N} världar dömda`);
  const done = recs.slice(0, prefix);

  const perProfil = {};
  const perNivå = {};
  const perFamilj = {};
  const räknare = {};
  const matris = {};
  let simTimmar = 0;
  let rader = 0;
  const fynd = [];
  for (const r of done) {
    perProfil[r.radio] = (perProfil[r.radio] || 0) + 1;
    perNivå[r.nivå] = (perNivå[r.nivå] || 0) + 1;
    perFamilj[r.familj] = (perFamilj[r.familj] || 0) + 1;
    simTimmar += r.simTimmar;
    rader += r.rader;
    if (!räknare[r.radio]) räknare[r.radio] = {};
    addCounters(räknare[r.radio], r.räknare);
    const träffade = new Set(r.fynd.filter((f) => !f.räknare).map((f) => f.orakel));
    for (const g of [...ORAKELGRUPPER, 'alla']) {
      if (!matris[r.familj]) matris[r.familj] = {};
      if (!matris[r.familj][g]) matris[r.familj][g] = {};
      const cell = matris[r.familj][g][r.radio] || { prövat: 0, utslag: 0 };
      const judged = g.startsWith('H') || r.ok;
      if (judged) cell.prövat++;
      if (g === 'alla' ? träffade.size > 0 : träffade.has(g)) cell.utslag++;
      matris[r.familj][g][r.radio] = cell;
    }
    fynd.push(...r.fynd);
  }
  körning.fynd.push(...fynd);
  const sum = (g, radio) => Object.values(matris).reduce((acc, perG) => {
    const c = (perG[g] || {})[radio];
    return c ? { prövat: acc.prövat + c.prövat, utslag: acc.utslag + c.utslag } : acc;
  }, { prövat: 0, utslag: 0 });
  for (const radio of radios) {
    for (const g of ORAKELGRUPPER) {
      const c = sum(g, radio);
      if (c.prövat) {
        körning.täckning.rader.push({
          spår: 'synth', orakel: g, profil: radio, prövat: c.prövat, utslag: c.utslag,
        });
      }
    }
  }
  for (const fam of Object.keys(matris).sort()) {
    for (const radio of radios) {
      const c = (matris[fam].alla || {})[radio];
      if (c && c.prövat) {
        körning.täckning.rader.push({
          spår: 'synth', orakel: `familj ${fam} (alla orakel)`, profil: radio, prövat: c.prövat, utslag: c.utslag,
        });
      }
    }
  }
  addFlatCounters(körning, räknare);
  körning.täckning.synt = {
    världar: done.length,
    budget: N,
    perProfil: fromEntries(Object.keys(perProfil).sort().map((k) => [k, perProfil[k]])),
    perNivå: fromEntries(Object.keys(perNivå).sort().map((k) => [k, perNivå[k]])),
    perFamilj: fromEntries(Object.keys(perFamilj).sort().map((k) => [k, perFamilj[k]])),
    simTimmar: Math.round(simTimmar * 10) / 10,
    rader,
    fel: done.filter((r) => !r.ok && !r.häng).length,
    häng: done.filter((r) => r.häng).length,
    räknare,
    matris,
    determinism: {
      radHash: hashJson(done.map((r) => r.radHash)),
      fyndHash: hashJson(fynd.filter((f) => !f.räknare).map(stripPaths)),
    },
    radioprofiler: radios,
    familjer: families,
  };
  körning.hälsa.synt = {
    världar: done.length,
    determinism: körning.täckning.synt.determinism,
    text: `${done.length} världar; fingeravtryck rader ${körning.täckning.synt.determinism.radHash.slice(0, 12)}, `
      + `fynd ${körning.täckning.synt.determinism.fyndHash.slice(0, 12)} (samma seed och HEAD ger samma värden); `
      + `${körning.täckning.synt.fel} körfel och ${körning.täckning.synt.häng} häng`,
  };
  return körning;
}

// ---------------------------------------------------------------------------
// Fas 4: krympning och bekräftelse
// ---------------------------------------------------------------------------

function makeProbe(körning, {
  dir, monitoring, budget, index,
}) {
  const cache = new Map();
  let n = 0;
  const okalibrerade = (körning.hälsa.kalibrering && körning.hälsa.kalibrering.okalibrerade) || [];
  return async (spec, { radio, nocache = false, räknaBudget = true } = {}) => {
    const built = core.materialize(spec, { profile: radio });
    const key = `${radio}|${built.radHash}|${monitoring ? 1 : 0}`;
    if (!nocache && cache.has(key)) return { ...cache.get(key), built };
    if (räknaBudget) {
      budget.prov++;
      budget.kostnadMs += costModelMs({ rader: built.rows.length, simTimmar: built.simTimmar });
    }
    const namn = `p${String(n++).padStart(3, '0')}`;
    const { utfall, jsonlPath } = await core.runBuilt(körning.pool, built, { dir, namn, monitoring });
    const dom = core.judgeBuilt({
      built,
      utfall,
      jsonlPath,
      register: körning.register,
      h3Baslinje: körning.hälsa.h3Baslinje,
      okalibrerade,
      meta: {
        index, radio, monitoring, profil: körning.profil.namn,
      },
      räkna: false,
    });
    fs.rmSync(jsonlPath, { force: true });
    const entry = { fynd: dom.fynd, utfall };
    if (!nocache) cache.set(key, entry);
    return { ...entry, built };
  };
}

function timelineOf(built, resultat, f) {
  const tl = core.timelineFor(built, resultat ? namespaceEventIds(resultat, built.rows) : null, f);
  return { tidslinje: tl.kort, tidslinjeFull: tl.full };
}

/** Kortets tidslinje ur den sparade världen (utan ny replay). */
function enrichUnshrunk(f) {
  const recept = f.repro && f.repro.recept;
  const specFile = (f.repro.filer || []).find((x) => x.till === 'repro.spec.json');
  const resultFile = (f.repro.filer || []).find((x) => x.till === 'repro.result.json');
  if (!recept || !specFile || !fs.existsSync(specFile.från)) return;
  const doc = JSON.parse(fs.readFileSync(specFile.från, 'utf8'));
  const built = core.materialize(doc.spec, { profile: doc.radio.profil });
  const resultat = resultFile && fs.existsSync(resultFile.från) ? JSON.parse(fs.readFileSync(resultFile.från, 'utf8')) : null;
  Object.assign(f.repro, timelineOf(built, resultat && resultat.notifications ? resultat : null, f), {
    tidslinjeRubrik: 'Sanning och app (hela världen; urval vid fyndets bro, allt i tidslinje.txt):',
    bekräftelse: f.repro.bekräftelse || 'ej krympt och ej bekräftad (--no-shrink eller utanför profilens topp-N).',
  });
}

/**
 * Krymper och bekräftar en representant (muterar f.repro och sätter f.bekräftelse).
 */
/**
 * Krymper och bekräftar ett utslag på en spec (fas 4; även för fristående
 * prov). Returnerar null om utslaget inte återkommer i världen.
 * @param {object} körning - {pool, register, hälsa, profil, tidenUte}
 * @param {object} args - {spec, radio, monitoring, f, mål, dir, index}
 * @returns {Promise<object|null>} {res, fin, finHit, bekr, budget}
 */
async function krympOchBekräfta(körning, {
  spec, radio, monitoring, f, mål, dir, index,
}) {
  fs.mkdirSync(dir, { recursive: true });
  const budget = shrink.makeBudget({ stopp: körning.tidenUte });
  const probe = makeProbe(körning, {
    dir, monitoring, budget, index,
  });
  const holdsF = (fynd) => fynd.some((x) => core.matchesTarget(x, mål));
  const p0 = await probe(spec, { radio });
  if (!holdsF(p0.fynd)) return null;
  const res = await shrink.shrinkSpec(spec, {
    mmsi: f.mmsi, mmsis: mål.mmsis, bro: f.bro, t: f.t,
  }, {
    holds: async (s) => holdsF((await probe(s, { radio })).fynd),
    measure: async (s, param) => {
      const r = await probe(s, { radio });
      return { holds: holdsF(r.fynd), mått: param.mått ? param.mått.fn(r.built) : undefined };
    },
    budget,
    radio,
  });
  const fin = await probe(res.spec, { radio, räknaBudget: false });
  const finHit = fin.fynd.find((x) => core.matchesTarget(x, mål)) || null;
  const bekr = await confirm.confirmRepro({
    spec: res.spec,
    radio,
    probe: (s, o) => probe(s, { ...o, räknaBudget: false }),
    holds: holdsF,
    final: fin,
    rehash: (text) => core.materialize(JSON.parse(text), { profile: radio }).radHash,
  });
  return {
    res, fin, finHit, bekr, budget,
  };
}

/**
 * Krymper och bekräftar en representant (muterar f.repro och sätter f.bekräftelse).
 * @returns {Promise<{nödbroms: boolean}>} om nödbromsen bromsade budgeten
 *   (då är repron delvis krympt efter väggklockan och rapporten AVKORTAD)
 */
async function shrinkOne(körning, f, jobId) {
  const specFile = (f.repro.filer || []).find((x) => x.till === 'repro.spec.json');
  const doc = JSON.parse(fs.readFileSync(specFile.från, 'utf8'));
  const radio = doc.radio.profil;
  const { monitoring } = doc;
  const { mål } = f.repro.recept;
  const dir = path.join(körning.temp, 'fas4', jobId);
  const out = await krympOchBekräfta(körning, {
    spec: doc.spec, radio, monitoring, f, mål, dir, index: f.repro.recept.värld,
  });
  if (!out) {
    f.bekräftelse = { instrumentfel: 'H5: utslaget återkom inte när världen kördes om', knivsegg: false, r0Bekräftad: false };
    f.repro.bekräftelse = 'INTE deterministisk: utslaget återkom inte när världen kördes om (INSTRUMENTFEL).';
    enrichUnshrunk(f);
    return { nödbroms: false };
  }
  const {
    res, fin, finHit, bekr, budget,
  } = out;
  const files = {
    spec: path.join(dir, 'repro.spec.json'),
    jsonl: path.join(dir, 'repro.jsonl'),
    truth: path.join(dir, 'repro.truth.json'),
    result: path.join(dir, 'repro.result.json'),
    gräns: path.join(dir, 'gräns.json'),
  };
  fs.writeFileSync(files.spec, core.specFileContent(fin.built, { monitoring }));
  fs.writeFileSync(files.jsonl, fin.built.jsonl);
  fs.writeFileSync(files.truth, `${JSON.stringify(truthToJson(fin.built.truth), null, 1)}\n`);
  fs.writeFileSync(files.result, `${JSON.stringify(resultatFörFil(fin.utfall), null, 1)}\n`);
  const gräns = res.gränser.find((g) => g.gränsHittad) || res.gränser[0] || null;
  fs.writeFileSync(files.gräns, `${JSON.stringify({ gränser: res.gränser }, null, 1)}\n`);
  const mon = monitoring ? 'REPLAY_MONITORING=1 ' : '';
  const anchor = finHit || f;
  f.repro = {
    ...f.repro,
    filer: [
      { från: files.jsonl, till: 'repro.jsonl' },
      { från: files.spec, till: 'repro.spec.json' },
      { från: files.truth, till: 'repro.truth.json' },
      { från: files.result, till: 'repro.result.json' },
      { från: files.gräns, till: 'gräns.json' },
    ],
    kommandon: [`${mon}node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl`, 'npm run hunt:repro -- <fynd>'],
    krympt: true,
    underlag: `${core.describeWorld(fin.built)}${res.delvis ? ` — delvis krympt (${res.delvisSkäl})` : ''}.`,
    tidslinjeRubrik: 'Sanning och app (minsta repro; urval vid fyndets bro, allt i tidslinje.txt):',
    ...timelineOf(fin.built, fin.utfall.resultat, anchor),
    gräns: gräns ? shrink.boundaryText(gräns) : null,
    bekräftelse: bekr.text,
    minstaUtslag: finHit ? finHit.detalj : null,
    recept: {
      ...f.repro.recept,
      krympt: true,
      delvis: res.delvis,
      radHash: fin.built.radHash,
      steg: res.steg,
      prov: budget.prov,
      modelleradKostnadS: Math.round(budget.kostnadMs / 100) / 10,
      ursprungsvärld: { värld: f.repro.recept.värld, seed: f.repro.recept.seed, radHash: f.repro.recept.radHash },
    },
  };
  f.bekräftelse = {
    instrumentfel: bekr.instrumentfel, knivsegg: bekr.knivsegg, r0Bekräftad: bekr.r0Bekräftad, steg: bekr.steg,
  };
  return { nödbroms: !!budget.nödbroms };
}

function applyConfirmation(c) {
  const reps = (c.representanter || []).filter((f) => f.bekräftelse);
  if (!reps.length) return;
  const fel = reps.filter((f) => f.bekräftelse.instrumentfel);
  if (fel.length === reps.length) {
    c.registerklass = 'INSTRUMENTFEL';
    c.post = 'BEKRÄFTELSE';
    c.instrumentfel = fel[0].bekräftelse.instrumentfel;
    return;
  }
  const ok = reps.filter((f) => !f.bekräftelse.instrumentfel);
  if (c.nivå === 'R1' && ok.some((f) => f.bekräftelse.r0Bekräftad)) {
    c.nivå = 'R0';
    c.r0Bekräftad = true;
    for (const f of ok.filter((x) => x.bekräftelse.r0Bekräftad)) f.taggar = [...new Set([...f.taggar, 'R0-BEKRÄFTAD'])].sort();
  }
  for (const f of ok.filter((x) => x.bekräftelse.knivsegg)) f.taggar = [...new Set([...f.taggar, 'KNIVSEGG'])].sort();
  if (ok.every((f) => f.bekräftelse.knivsegg)) c.knivsegg = true;
  clusterLib.rescore(c);
}

/**
 * Fas 4 för sanningsspåret: krympning och bekräftelse (krymp=false: bara
 * kortens tidslinjer ur de sparade världarna).
 *
 * Nödbromsen (--max-minutes) gör rapporten AVKORTAD när den kan ha påverkat
 * fasen: en budget som bromsades (repron är då "delvis krympt" efter
 * väggklockan), ett jobb som aldrig hann starta (obekräftat; kortet får
 * tidslinjen ur den sparade världen) eller en tid som är slut efter en
 * krympning. Utan krympning (--no-shrink, eller nödbroms=true när hunt.js
 * redan märkt fasen) märker spåret ingenting.
 * @param {object} körning - körningsobjektet efter fas 3
 * @param {{n: number, perKluster: number, krymp: boolean, nödbroms?: boolean}} opts -
 *   profilens representanter; nödbroms=true när hunt.js hoppade över
 *   krympningen för att tiden redan var slut
 */
async function krympAlla(körning, {
  n, perKluster, krymp = true, nödbroms = false,
}) {
  const mine = körning.kluster.filter((c) => (c.fördelning.spår || {}).synth);
  const kand = mine.filter((c) => c.registerklass === 'KANDIDAT');
  const konf = mine.filter((c) => c.registerklass === 'KONFLIKT');
  const valda = krymp ? [...kand.slice(0, n), ...konf.slice(0, Math.min(MAX_KONFLIKTEXEMPEL, n))] : [];
  const jobs = [];
  valda.forEach((c, ci) => {
    c.representanter = clusterLib.chooseRepresentatives(c, perKluster);
    c.representanter.forEach((f, j) => {
      if (f.spår === 'synth' && f.repro && f.repro.recept) jobs.push({ f, id: `k${String(ci + 1).padStart(2, '0')}-r${j + 1}` });
    });
  });
  const utfall = await mapPool(jobs, körning.pool.jobb, (job) => shrinkOne(körning, job.f, job.id), körning.tidenUte);
  const obekräftade = jobs.filter((_, i) => utfall[i] === undefined);
  const nödbromsade = jobs.filter((_, i) => utfall[i] && utfall[i].nödbroms);
  for (const j of obekräftade) {
    j.f.repro.bekräftelse = 'ej krympt och ej bekräftad: nödbromsen (--max-minutes) hann före (AVKORTAD).';
    if (!j.f.repro.tidslinje) enrichUnshrunk(j.f);
  }
  for (const c of valda) applyConfirmation(c);
  // Övriga kort: tidslinje ur den sparade världen (ingen replay).
  const resten = [...kand, ...konf].filter((c) => !valda.includes(c)).slice(0, MAX_KORT);
  for (const c of resten) {
    for (const f of clusterLib.chooseRepresentatives(c, perKluster)) {
      if (f.spår === 'synth' && f.repro && !f.repro.tidslinje) enrichUnshrunk(f);
    }
  }
  körning.kluster = clusterLib.sortClusters(körning.kluster);
  // Efter en krympning med replay märks rapporten också när tiden är slut
  // (försiktigt: ett jobb kan ha hunnit påverkas mellan två bromsprov).
  const tidenSlut = krymp && !!(körning.tidenUte && körning.tidenUte());
  if (obekräftade.length || nödbromsade.length || tidenSlut) {
    const delar = [];
    if (nödbromsade.length) delar.push(`${nödbromsade.length} av ${jobs.length} representanter delvis krympta av nödbromsen`);
    if (obekräftade.length) delar.push(`${obekräftade.length} av ${jobs.length} obekräftade`);
    if (!delar.length) delar.push('tiden var slut efter fasen');
    report.markeraAvkortad(körning, `fas 4 (krympning och bekräftelse): ${delar.join(', ')}`);
  }
  if (!krymp) {
    körning.täckning.krympning = {
      avstängd: true, representanter: 0, krympta: 0, ...(nödbroms ? { hoppadesÖver: 'nödbromsen (--max-minutes)' } : {}),
    };
    return;
  }
  körning.täckning.krympning = krympningsTäckning(jobs, { nödbromsade, obekräftade });
}

/**
 * Fas 4:s täckning (rapport.json täckning.krympning) ur de krympta jobben.
 * R1 → R0 flyttar bara R1-nivåns kluster till logikfel (applyConfirmation),
 * så `r0Bekräftade` räknar bara R1-fynd. Ett stressfynd med R1-radio som
 * reproducerar med R0 stannar under Stress och räknas i `r0BekräftadeStress`
 * (efterrättning D: förut räknades det som ett R1-fynd, och sammanfattningens
 * "1 R1-fynd reproducerar med R0" avsåg ett stresskort).
 * @param {{f: object}[]} jobs - representanterna som krymptes
 * @param {{nödbromsade: object[], obekräftade: object[]}} broms - nödbromsens utfall
 * @returns {object} täckningen
 */
function krympningsTäckning(jobs, { nödbromsade = [], obekräftade = [] } = {}) {
  const done = jobs.filter((j) => j.f.bekräftelse);
  const r0 = done.filter((j) => j.f.bekräftelse.r0Bekräftad && j.f.repro.recept && j.f.repro.recept.radio === 'R1');
  return {
    representanter: jobs.length,
    krympta: done.filter((j) => j.f.repro.krympt).length,
    delvis: done.filter((j) => j.f.repro.recept && j.f.repro.recept.delvis).length,
    instrumentfel: done.filter((j) => j.f.bekräftelse.instrumentfel).length,
    r0Bekräftade: r0.filter((j) => j.f.nivå !== 'stress').length,
    r0BekräftadeStress: r0.filter((j) => j.f.nivå === 'stress').length,
    knivsegg: done.filter((j) => j.f.bekräftelse.knivsegg).length,
    prov: done.reduce((s, j) => s + ((j.f.repro.recept && j.f.repro.recept.prov) || 0), 0),
    nödbroms: nödbromsade.length,
    obekräftade: obekräftade.length,
  };
}

// ---------------------------------------------------------------------------
// hunt:repro
// ---------------------------------------------------------------------------

async function repro(katalog, körning) {
  const recept = JSON.parse(fs.readFileSync(path.join(katalog, 'recept.json'), 'utf8'));
  const doc = JSON.parse(fs.readFileSync(path.join(katalog, 'repro.spec.json'), 'utf8'));
  const radio = doc.radio.profil;
  const monitoring = !!doc.monitoring;
  const built = core.materialize(doc.spec, { profile: radio });
  let rund = 'okänd';
  if (recept.radHash) rund = recept.radHash === built.radHash ? 'bitlik' : 'AVVIKER';
  const { utfall, jsonlPath } = await core.runBuilt(körning.pool, built, { dir: path.join(körning.temp, 'repro'), namn: 'repro', monitoring });
  const dom = core.judgeBuilt({
    built,
    utfall,
    jsonlPath,
    register: körning.register,
    meta: {
      index: recept.värld, radio, monitoring, profil: 'repro',
    },
    räkna: false,
  });
  const kvar = dom.fynd.filter((f) => core.matchesTarget(f, recept.mål));
  const kort = dom.fynd.filter((f) => !f.räknare);
  console.log(`Repro ${path.basename(katalog)}: värld ${recept.värld} (seed ${recept.seed}), ${radio}${monitoring ? ', REPLAY_MONITORING=1' : ''}${recept.krympt ? ', minsta repro' : ''}`);
  console.log(`  rader ur sparad spec: ${built.rows.length} (${rund} mot den sparade radhashen)`);
  console.log(`  sparad mekanism: ${recept.mål.mekanism}${recept.mål.bro ? ` vid ${recept.mål.bro}` : ''} [${recept.mål.registerklass}${recept.mål.post ? ` ${recept.mål.post}` : ''}]`);
  // En körning som fallerar kan inte döma ett sanningsorakel: KAN INTE DÖMAS,
  // aldrig BORTA (H1/H2-kort reproducerar däremot just genom att fallera).
  const kanInte = !utfall.ok && !kvar.length;
  let svar = kvar.length ? 'KVAR' : 'BORTA';
  if (kanInte) svar = 'KAN INTE DÖMAS';
  console.log(`  utfall mot aktuell HEAD: ${svar} (${kort.length} utslag i världen${utfall.ok ? '' : `; körfel: ${utfall.fel}`})`);
  for (const f of kort) console.log(`  - ${f.orakel} ${f.klass} [${f.register.klass}${f.register.post ? ` ${f.register.post}` : ''}]: ${String(f.detalj).slice(0, 200)}`);
  return kanInte ? EXIT_KAN_INTE_DÖMAS : 0;
}

/** Kortets kanarie-id ur receptet, eller ur de sparade fynden (äldre kort). */
function kanarieIdOf(recept, sparat) {
  if (recept && recept.kanarie) return recept.kanarie;
  const f = ((sparat && sparat.fynd) || []).find((x) => (x.belägg && x.belägg.kanarie) || (x.ursprung && x.ursprung.kanarie));
  return f ? (f.belägg.kanarie || f.ursprung.kanarie) : null;
}

/** Kortets korpus ur receptet, eller ur de sparade fynden. */
function korpusIdOf(recept, sparat) {
  if (recept && recept.korpus) return recept.korpus;
  const f = ((sparat && sparat.fynd) || []).find((x) => x.ursprung && x.ursprung.korpus);
  return f ? f.ursprung.korpus : null;
}

function kanInteDöma(katalog, sparat, skäl) {
  console.log(`Repro ${path.basename(katalog)}: KAN INTE DÖMAS för ${sparat.mekanism} — ${skäl}`);
  return EXIT_KAN_INTE_DÖMAS;
}

/**
 * hunt:repro för ett S-KALIBRERING-kort: basen (bas.jsonl, och bas.state.json
 * när korpusen har starttillstånd) körs om och döms med T1/T10 mot
 * banksanningen och registret — samma kalibreraKorpus som självtestet.
 *
 * Kortet skapades för en OREGISTRERAD träff (registerklass KANDIDAT), så
 * svaret är KVAR bara när mekanismen fortfarande ger en oregistrerad träff på
 * korpusen. Registrerade träffar av samma mekanism är kända utfall som inte
 * gav kortet; de räknas och visas som information. Rättat 2026-11-04
 * (efterrättning D): förut räknades även de som KVAR, så ett kalibreringskort
 * kunde aldrig bli BORTA på en korpus där mekanismen har registrerade
 * träffar (T1 NOTIS-UTEBLIVEN i 42h har åtta). Varje utslag listas med sin
 * registerklass.
 * @param {string} katalog - fyndkatalogen
 * @param {object} körning - {pool, register, temp}
 * @param {{sparat: object, recept: object}} kort - fynd.json och recept.json
 * @returns {Promise<number>} exitkod (0 för KVAR/BORTA, 2 för KAN INTE DÖMAS)
 */
async function reproKalibrering(katalog, körning, { sparat, recept }) {
  const korpusId = korpusIdOf(recept, sparat);
  const korpus = korpusId ? bankOps.corpusList().find((c) => c.id === korpusId) : null;
  if (!korpus) return kanInteDöma(katalog, sparat, korpusId ? `okänd korpus ${korpusId}` : 'kortet namnger ingen korpus');
  const jsonl = path.join(katalog, 'bas.jsonl');
  if (!fs.existsSync(jsonl)) return kanInteDöma(katalog, sparat, 'katalogen saknar bas.jsonl');
  const kc = bankOps.readCorpus({ id: korpus.id, jsonl });
  const [u] = await körning.pool.runAll([{
    jsonl, etikett: `${korpus.id} bas`, rader: kc.rader.length, simTimmar: kc.simTimmar,
  }]);
  if (!u.ok) return kanInteDöma(katalog, sparat, `basen kunde inte köras: ${u.fel}`);
  const { fynd } = kalibreraKorpus(körning.register, selftest.baseEntry(korpus, kc, u), { räkna: false });
  const träffar = fynd.filter((f) => mechanismOf(f) === sparat.mekanism);
  const poster = {};
  for (const f of träffar) if (f.register.klass !== 'KANDIDAT') poster[f.register.post] = (poster[f.register.post] || 0) + 1;
  const oreg = träffar.filter((f) => f.register.klass === 'KANDIDAT').length;
  const reg = Object.entries(poster).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(', ');
  const orakel = String(sparat.mekanism).split('|')[0];
  console.log(`Repro ${path.basename(katalog)}: S-KALIBRERING på ${korpus.id} (${orakel}), bas.jsonl ${kc.rader.length} rader${kc.statePath ? ' med bas.state.json' : ''}`);
  console.log(`  sparad mekanism: ${sparat.mekanism}`);
  // Bara oregistrerade träffar (det som gav kortet) håller kortet kvar.
  console.log(`  utfall mot aktuell HEAD: ${oreg ? 'KVAR' : 'BORTA'} (${oreg} oregistrerade utslag av mekanismen; `
    + `${träffar.length - oreg} registrerade, som information${reg ? ` — ${reg}` : ''})`);
  for (const f of fynd) console.log(`  - ${f.orakel} ${f.klass} [${f.register.klass}${f.register.post ? ` ${f.register.post}` : ''}]: ${String(f.detalj).slice(0, 200)}`);
  return 0;
}

/**
 * hunt:repro för ett S-KANARIE-kort: kanarien byggs om ur canaries/kanarier.json,
 * körs och prövas med samma kanariekontroll som självtestet (runCanaries →
 * checkCanary). KVAR när samma produktförväntan fortfarande bryts. Ett brutet
 * instrumentkrav (INSTRUMENT BLINT) eller ett körfel ger KAN INTE DÖMAS.
 * @param {string} katalog - fyndkatalogen
 * @param {object} körning - {pool, temp}
 * @param {{sparat: object, recept: object}} kort - fynd.json och recept.json
 * @returns {Promise<number>} exitkod
 */
async function reproKanarie(katalog, körning, { sparat, recept }) {
  const id = kanarieIdOf(recept, sparat);
  const k = id ? selftestSynth.loadCanaries().find((x) => x.id === id) : null;
  if (!k) return kanInteDöma(katalog, sparat, id ? `kanarien ${id} finns inte i canaries/kanarier.json` : 'kortet namnger ingen kanarie');
  const dir = path.join(körning.temp, 'repro-kanarie');
  const kan = await selftestSynth.runCanaries({ runReplay: poolRunner(körning), tmpDir: dir, canaries: [k] });
  const res = kan.kanarier[0];
  if (res.fel) return kanInteDöma(katalog, sparat, `kanarien kunde inte köras: ${res.fel}`);
  if (!res.instrumentOk) {
    return kanInteDöma(katalog, sparat, `INSTRUMENT BLINT: ${res.instrument.filter((x) => !x.ok).map((x) => x.namn).join(', ')}`);
  }
  const sparad = path.join(katalog, 'repro.jsonl');
  let rund = 'kortet saknar repro.jsonl';
  if (fs.existsSync(sparad) && res.jsonlPath && fs.existsSync(res.jsonlPath)) {
    rund = fs.readFileSync(sparad, 'utf8') === fs.readFileSync(res.jsonlPath, 'utf8') ? 'bitlik med kortets repro.jsonl' : 'AVVIKER från kortets repro.jsonl';
  }
  const fynd = canaryFindings(res);
  const kvar = fynd.filter((f) => mechanismOf(f) === sparat.mekanism);
  console.log(`Repro ${path.basename(katalog)}: kanarien ${k.id} (${res.rader} rader, R0; ${rund})`);
  console.log(`  sparad mekanism: ${sparat.mekanism}`);
  console.log(`  utfall mot aktuell HEAD: ${kvar.length ? 'KVAR' : 'BORTA'} (${fynd.length} brutna produktförväntningar)`);
  for (const f of fynd) console.log(`  - ${f.orakel} ${f.klass}: ${f.detalj}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Sammanfattning
// ---------------------------------------------------------------------------

function sammanfattning(körning) {
  const s = körning.täckning.synt;
  if (!s) return 'Sanningsspåret: kördes inte (självtestet stoppade jakten).';
  const mine = (körning.kluster || []).filter((c) => (c.fördelning.spår || {}).synth);
  const kand = mine.filter((c) => c.registerklass === 'KANDIDAT');
  const perNivå = (nivå) => kand.filter((c) => c.nivå === nivå).length;
  const kända = mine.filter((c) => !['KANDIDAT', 'INSTRUMENTFEL'].includes(c.registerklass)).length;
  const k = körning.täckning.krympning;
  let kr = '';
  if (k && k.avstängd) kr = k.hoppadesÖver ? `; krympningen hoppades över (${k.hoppadesÖver}; AVKORTAD)` : '; krympningen avstängd (--no-shrink)';
  else if (k) {
    kr = `; ${k.krympta} av ${k.representanter} representanter krympta och bekräftade${k.delvis ? ` (${k.delvis} delvis)` : ''}`
      + `${k.r0Bekräftade ? `, ${k.r0Bekräftade} R1-fynd reproducerar med R0 (flyttade till logikfel)` : ''}`
      + `${k.r0BekräftadeStress ? `, ${k.r0BekräftadeStress} stressfynd med R1-radio reproducerar med R0 (stannar under Stress)` : ''}`
      + `${k.instrumentfel ? `, ${k.instrumentfel} INSTRUMENTFEL` : ''}`;
    // Nödbromsen i fas 4 gör krympningen väggklockberoende (§3).
    const avk = [
      k.nödbroms ? `${k.nödbroms} delvis krympta av nödbromsen` : '',
      k.obekräftade ? `${k.obekräftade} obekräftade` : '',
    ].filter(Boolean);
    if (avk.length) kr += `; AVKORTAD av nödbromsen i fas 4: ${avk.join(' och ')}`;
  }
  const rå = körning.fynd.filter((f) => f.spår === 'synth' && !f.räknare).length;
  const prof = Object.entries(s.perProfil).map(([p, v]) => `${p} ${v}`).join(', ');
  return `Sanningsspåret: ${s.världar} världar (${prof}; stress ${s.perNivå.stress || 0}) på ${fmtNum(s.simTimmar, 1)} simulerade timmar; `
    + `${rå} råa utslag → ${kand.length} kandidatkluster (logikfel R0 ${perNivå('R0')}, robusthet R1 ${perNivå('R1')}, stress ${perNivå('stress')}) `
    + `och ${kända} kluster med registerpost${kr}.${s.världar < s.budget ? ` AVKORTAD: ${s.världar} av ${s.budget} världar.` : ''}`;
}

module.exports = {
  id: 'synth',
  fas: 2,
  titel: 'Sanningsspåret',
  kontrollera,
  kör,
  självtest,
  krympAlla,
  repro,
  reproKalibrering,
  reproKanarie,
  sammanfattning,
  // för tester och fristående prov
  kalibrera,
  kalibreraKorpus,
  canaryFindings,
  krympOchBekräfta,
  laneOptions,
  reproFor,
  resultatFörFil,
  krympningsTäckning,
  applyConfirmation,
};
