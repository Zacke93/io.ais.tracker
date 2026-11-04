'use strict';

/**
 * Självtestets sanningsdelar (BUGGJAKT.md §11, orakelkatalogen):
 *
 *   S-KANARIE      fem R0-världar med exakt känt facit (canaries/kanarier.json):
 *                  instrumentkrav (stoppar körningen) och produktförväntningar
 *                  (blir kortet KANARIE överst i rapporten), plus bankens
 *                  instrumenttotaler över basresultaten.
 *   S-RUNDRESA     spec → JSON → simulering och observation två gånger ur den
 *                  tolkade JSON:en på djupfryst spec; radhasharna ska vara lika.
 *   S-KALIBRERING  T1 och T10 på bankens basresultat med rådatafacit som L1.
 *                  Varje träff ska vara förklarad eller registrerad med korpus-id;
 *                  annars märks oraklet okalibrerat i körningen.
 *
 * Modulen är ett rent bibliotek för selftest.js. Replay sker bara via den
 * inskickade runReplay (pool.js i motorn).
 */

const fs = require('fs');
const path = require('path');

const { deepFreeze, hashRows } = require('./rng');
const { sampleWorld } = require('./families');
const { simulateWorld } = require('./world');
const { observeWorld, checkRows, toJsonl } = require('./radio');
const { worldTruth, bankTruth, asGt } = require('./truth');
const gates = require('../../runOpeningGates');
const { judgeT1 } = require('./oracles/t1Notice');
const { judgeT10 } = require('./oracles/t10Passage');
const { judgeT2T3, canaryFloorMs } = require('./oracles/t2Opening');
const { statusOf } = require('./oracles/truthJudge');
const {
  deliveredNotices, deliveredWarnings, hms, samplesFromRows,
} = require('./oracles/truthCommon');
const { BRIDGE_TEXT_CONSTANTS } = require('../../../../lib/constants');

const CANARY_FILE = path.join(__dirname, '..', 'canaries', 'kanarier.json');
const DEFAULT_TEXT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;

/** Läs kanariefilen. */
function loadCanaries(file = CANARY_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).kanarier;
}

/**
 * Bygg en kanarievärld: frusen spec, R0-observation, sanning.
 * @param {object} k - post ur kanarier.json
 * @returns {object} {spec, sim, rows, truth}
 */
function buildCanary(k) {
  const spec = deepFreeze(JSON.parse(JSON.stringify(k.spec)));
  const sim = simulateWorld(spec);
  const { rows } = observeWorld(sim, { profile: k.radio.profil, overrides: k.radio.overrides || {} });
  checkRows(rows);
  return {
    spec, sim, rows, truth: worldTruth(sim, rows),
  };
}

/**
 * Pröva en kanarie mot sitt replayresultat.
 * @param {object} k - post ur kanarier.json
 * @param {object} built - buildCanary-resultat
 * @param {object} result - replayresultat
 * @returns {{instrument:object[], produkt:object[], instrumentOk:boolean, produktOk:boolean}} utfall
 */
function checkCanary(k, built, result) {
  const { truth, spec } = built;
  const notes = deliveredNotices(result);
  const warnings = deliveredWarnings(result);
  const boats = spec.boats.map((b) => String(b.mmsi));
  const instrument = [];
  const produkt = [];
  const req = (list, namn, ok, värde) => list.push({ namn, ok: !!ok, värde });
  // Instrumentkrav: fångar wrappers som tystnat efter ett namnbyte.
  const tp = result.targetPassages || [];
  const ip = result.intermediatePassages || [];
  req(instrument, 'notiser > 0', notes.length > 0, notes.length);
  for (const m of boats) req(instrument, `målbropassager ≥ 2 för ${m}`, tp.filter((p) => String(p.mmsi) === m).length >= 2, tp.filter((p) => String(p.mmsi) === m).length);
  req(instrument, 'mellanbropassager > 0', ip.length > 0, ip.length);
  req(instrument, 'öppningsvarningar ≥ 1', warnings.length >= 1, warnings.length);
  if (boats.length > 1) {
    const absorbed = (result.openingCoverage || []).filter((c) => c.reason === 'absorbed').length;
    req(instrument, 'openingCoverage absorbed ≥ 1 (konvojparet)', absorbed >= 1, absorbed);
  }
  req(instrument, 'textövergångar > 0', (result.bridgeTextTransitions || []).length > 0, (result.bridgeTextTransitions || []).length);
  // Produktförväntningar: exakt en notis per punkt och transit.
  for (const m of boats) {
    const mine = notes.filter((n) => String(n.mmsi) === m);
    const perPoint = {};
    for (const n of mine) perPoint[n.bridge] = (perPoint[n.bridge] || 0) + 1;
    const points = ['Kanalinfarten', 'Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'];
    req(produkt, `exakt en notis per punkt för ${m} (6)`, points.every((p) => perPoint[p] === 1) && mine.length === 6, perPoint);
    req(produkt, `2 målbropassager för ${m}`, tp.filter((p) => String(p.mmsi) === m).length === 2, tp.filter((p) => String(p.mmsi) === m).length);
  }
  // Ledtid mot sann korsning över kanariegolvet (beror på kadens).
  const floorMs = canaryFloorMs(k.radio.intervalS || 30);
  const t2 = judgeT2T3({
    result, rows: built.rows, truth, world: spec, opts: { ledtidsgolvMs: floorMs },
  });
  const ledtidFel = t2.fynd.filter((f) => f.orakel === 'T2');
  req(produkt, `alla målbrokorsningar täckta med ledtid ≥ ${Math.round(floorMs / 1000)} s`, ledtidFel.length === 0, ledtidFel.map((f) => `${f.klass} ${f.bro} ${f.mmsi}`));
  // Ledtiden mot den TÄCKANDE varningen (O1:s analyseCoverage med L1-punktfacit).
  const cov = gates.analyseCoverage(result, samplesFromRows(built.rows), asGt(truth.L1.crossings, { targetsOnly: true, pointOnly: true }));
  const leads = cov.covered.map((c) => ({
    mmsi: String(c.passage.mmsi), bro: c.passage.bridge, ledtidS: Math.round(c.leadMs / 1000), eventId: c.warning.eventId, via: c.via,
  }));
  const perBridge = {};
  for (const w of warnings) perBridge[w.bridge] = (perBridge[w.bridge] || 0) + 1;
  req(produkt, 'minst en varning per målbro', ['Klaffbron', 'Stridsbergsbron'].every((b) => perBridge[b] >= 1), perBridge);
  // Fler än en varning per målbro är T4:s >1-räknare: U2 mot deadline-garantin
  // är en öppen ägarfråga (etapp7-plan C-IV), så det redovisas men fäller inte.
  const info = [];
  if (Object.values(perBridge).some((n) => n > 1)) {
    info.push({ namn: 'fler än en varning per målbro (T4 >1, U2 mot deadline, öppen fråga)', värde: warnings.map((w) => `${w.bridge} ${w.eventId} ${hms(w.t)} ${w.leadMmsi}`) });
  }
  // DEFAULT inom 120 s efter sista målbrokorsningen (uppmätt 21–54 s).
  const lastTarget = truth.L0.crossings.filter((x) => x.bridge === 'Klaffbron' || x.bridge === 'Stridsbergsbron').pop();
  const trans = result.bridgeTextTransitions || [];
  const def = lastTarget ? trans.find((x) => x.t >= lastTarget.t && x.text === DEFAULT_TEXT) : null;
  const defAfterS = def ? Math.round((def.t - lastTarget.t) / 1000) : null;
  req(produkt, 'DEFAULT inom 120 s efter sista målbrokorsningen', defAfterS !== null && defAfterS <= 120, defAfterS);
  return {
    id: k.id,
    instrument,
    produkt,
    info,
    ledtider: leads,
    instrumentOk: instrument.every((x) => x.ok),
    produktOk: produkt.every((x) => x.ok),
  };
}

/**
 * Kör kanarierna genom runReplay.
 * @param {object} o - {runReplay, tmpDir, canaries?}
 * @returns {Promise<object>} {kanarier:[…], instrumentOk, produktOk}
 */
async function runCanaries({ runReplay, tmpDir, canaries = loadCanaries() }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = [];
  for (const k of canaries) {
    const built = buildCanary(k);
    const jsonlPath = path.join(tmpDir, `kanarie-${k.id}.jsonl`);
    fs.writeFileSync(jsonlPath, toJsonl(built.rows));
    // eslint-disable-next-line no-await-in-loop
    const run = await runReplay(jsonlPath, { monitoring: false, timeoutMs: 60000 });
    const result = run && Array.isArray(run.notifications) ? run : (run && run.result);
    if (!result) {
      out.push({
        id: k.id, instrumentOk: false, produktOk: false, fel: (run && run.error) || 'inget resultat', instrument: [], produkt: [],
      });
      continue;
    }
    out.push({ ...checkCanary(k, built, result), jsonlPath, rader: built.rows.length });
  }
  return { kanarier: out, instrumentOk: out.every((x) => x.instrumentOk), produktOk: out.every((x) => x.produktOk) };
}

/**
 * Bankens instrumentkrav (S-KANARIE): totalerna över basresultaten ska vara > 0.
 * @param {object[]} results - basresultat
 * @returns {{ok:boolean, totaler:object}} utfall
 */
function bankInstrumentCheck(results) {
  const tot = {
    targetPassages: 0,
    intermediatePassages: 0,
    openingWarnings: 0,
    absorberadTäckning: 0,
    visitReentries: 0,
    journeyResets: 0,
    confirmedTargetWaits: 0,
    notiserAlreadyPassed: 0,
    notiserPassageFallback: 0,
  };
  for (const r of results) {
    if (!r) continue;
    tot.targetPassages += (r.targetPassages || []).length;
    tot.intermediatePassages += (r.intermediatePassages || []).length;
    tot.openingWarnings += (r.openingWarnings || []).length;
    tot['absorberadTäckning'] += (r.openingCoverage || []).filter((c) => c.reason === 'absorbed').length;
    tot.visitReentries += (r.visitReentries || []).length;
    tot.journeyResets += (r.journeyResets || []).length;
    tot.confirmedTargetWaits += (r.confirmedTargetWaits || []).length;
    tot.notiserAlreadyPassed += (r.notifications || []).filter((n) => n.alreadyPassed === true).length;
    tot.notiserPassageFallback += (r.notifications || []).filter((n) => n.source === 'passage-fallback').length;
  }
  return { ok: Object.values(tot).every((v) => v > 0), totaler: tot };
}

/**
 * S-RUNDRESA: varje spec simuleras och observeras två gånger ur sin
 * JSON-form på djupfryst spec; hashen ska vara lika (och lika med originalets).
 * @param {object} [o] - {seed, n, profiles, specs}
 * @returns {{prövade:number, avvikelser:object[]}} utfall
 */
function roundTrip({
  seed = 1, n = 20, profiles = ['R0', 'R1'], specs = null,
} = {}) {
  const list = specs || Array.from({ length: n }, (_, i) => sampleWorld(seed, i));
  const avvikelser = [];
  let prövade = 0;
  for (const spec of list) {
    for (const profile of profiles) {
      prövade++;
      const h0 = hashRows(observeWorld(simulateWorld(deepFreeze(JSON.parse(JSON.stringify(spec)))), { profile }).rows);
      const json = JSON.stringify(spec);
      let h1 = null;
      let h2 = null;
      let fel = null;
      try {
        h1 = hashRows(observeWorld(simulateWorld(deepFreeze(JSON.parse(json))), { profile }).rows);
        h2 = hashRows(observeWorld(simulateWorld(deepFreeze(JSON.parse(json))), { profile }).rows);
      } catch (e) {
        fel = e.message;
      }
      if (fel || h0 !== h1 || h1 !== h2) {
        avvikelser.push({
          seed: spec.seed, profile, fel, h0, h1, h2,
        });
      }
    }
  }
  return { prövade, avvikelser };
}

/**
 * S-KALIBRERING: T1 och T10 på bankens basresultat med rådatafacit som L1.
 * @param {object} o - {corpora, results (samma ordning), registered?: [{korpus, orakel, klass, mmsi, bro}]}
 * @returns {object} {tabell, träffar, oregistrerade, okalibrerade}
 */
function runBankCalibration({ corpora, results, registered = [] }) {
  const träffar = [];
  const tabell = {
    T1: {
      besök: 0, bedömda: 0, utslag: 0, förklarade: 0,
    },
    T10: {
      appPassager: 0, beslutsammaKorsningar: 0, utslag: 0, förklarade: 0,
    },
  };
  corpora.forEach((c, i) => {
    const result = results[i];
    if (!result) return;
    const rows = fs.readFileSync(c.jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const truth = bankTruth(c.id, rows);
    const ctx = { result, rows, truth };
    const t1 = judgeT1(ctx);
    const t10 = judgeT10(ctx);
    tabell.T1['besök'] += t1['räknare']['besök'];
    tabell.T1['bedömda'] += t1['räknare']['bedömda'];
    tabell.T10.appPassager += t10['räknare'].appPassager;
    tabell.T10['beslutsammaKorsningar'] += t10['räknare']['beslutsammaKorsningar'];
    for (const f of [...t1.fynd, ...t10.fynd]) {
      const key = f.orakel;
      tabell[key].utslag++;
      if (statusOf(f) !== 'KANDIDAT') tabell[key]['förklarade']++;
      träffar.push({ korpus: c.id, ...f });
    }
  });
  const isRegistered = (f) => registered.some((r) => r.korpus === f.korpus && r.orakel === f.orakel
    && (!r.klass || r.klass === f.klass) && (!r.mmsi || String(r.mmsi) === String(f.mmsi)) && (!r.bro || r.bro === f.bro));
  const oregistrerade = träffar.filter((f) => statusOf(f) === 'KANDIDAT' && !isRegistered(f));
  return {
    tabell,
    träffar,
    oregistrerade,
    okalibrerade: [...new Set(oregistrerade.map((f) => f.orakel))],
  };
}

module.exports = {
  CANARY_FILE, loadCanaries, buildCanary, checkCanary, runCanaries, bankInstrumentCheck, roundTrip, runBankCalibration,
};
