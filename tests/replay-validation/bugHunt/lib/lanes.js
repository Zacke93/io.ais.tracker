'use strict';

/**
 * Spårregistret — hur ett spår kopplas in i hunt.js.
 *
 * Ett spår är ett objekt:
 *   {
 *     id:       'synth'                    (namnet i --lanes=…)
 *     fas:      2                          (körordning; 0 = självtest, 1 = bank)
 *     titel:    'Sanningsspåret'
 *     kör:      async (körning) => körning lägger råa fynd i körning.fynd,
 *                                          rader i körning.täckning.rader och
 *                                          räknare i körning.täckning.räknare;
 *                                          varje fynd kan bära en icke-
 *                                          uppräkningsbar `kontext` för registret
 *     självtest?: async (körning) => void  körs i fas 0 efter bankens självtest
 *                                          (kanarier, rundresa, S-KALIBRERING)
 *     slåIhop?: (fynd, körning) => fynd    efter klassningen i fas 3, på spårets
 *                                          egna fynd (f.spår === id)
 *     krymp?:   async (körning, kluster, representanter) => void
 *                                          fas 4 (krympning och bekräftelse);
 *                                          sätter repro.krympt, repro.filer …
 *     repro?:   async (katalog, körning) => number  hunt:repro för spårets fynd
 *                                          (anropas när recept.json.spår === id)
 *     sammanfattning?: (körning) => string en rad till rapportens sammanfattning
 *   }
 *
 * Inbyggda spår: 'selftest' (fas 0) och 'bank' (fas 1). Övriga laddas
 * automatiskt ur lib/lanes/*.js — en modul per spår som exporterar objektet
 * ovan. Så kopplar integratören in sanningsspåret utan att röra hunt.js.
 */

const fs = require('fs');
const path = require('path');
const selftest = require('./selftest');
const relations = require('./relations');
const bankOps = require('./bankOps');
const health = require('./oracles/health');
const { mechanismOf } = require('./finding');
const { fmtDelta, markeraAvkortad, avkortadIFas } = require('./report');

const KNOWN_IDS = Object.freeze(['selftest', 'bank', 'synth']);
const LANES = new Map();

function registerLane(lane) {
  const missing = ['id', 'fas', 'titel', 'kör'].filter((k) => lane[k] === undefined);
  if (missing.length) throw new Error(`spåret saknar ${missing.join(', ')}`);
  if (typeof lane.kör !== 'function') throw new Error(`spåret ${lane.id}: kör måste vara en funktion`);
  LANES.set(lane.id, lane);
  return lane;
}

// ---------------------------------------------------------------------------
// Inbyggda spår
// ---------------------------------------------------------------------------

registerLane({
  id: 'selftest',
  fas: 0,
  titel: 'Självtest',
  async kör(körning) {
    await selftest.runSelftest(körning);
    return körning;
  },
});

/**
 * Kortets registerutfall ur fynd.json: klusternyckeln är
 * `registerklass | post | mekanism` (cluster.clusterKey, post '-' när ingen
 * post matchade). Saknas nyckeln, eller hör den till en annan mekanism,
 * används de sparade fyndens registerutfall. Annars null.
 * @param {object} sparat - fynd.json
 * @returns {{klass: string, post: string|null}|null} registerutfallet
 */
function kortetsRegisterutfall(sparat) {
  const [klass, post, ...mek] = typeof sparat.nyckel === 'string' ? sparat.nyckel.split('|') : [];
  if (klass && post !== undefined && mek.join('|').startsWith(String(sparat.mekanism))) return { klass, post: post === '-' ? null : post };
  const reg = (sparat.fynd || []).map((f) => f && f.register).find((r) => r && r.klass);
  return reg ? { klass: reg.klass, post: reg.post || null } : null;
}

/**
 * hunt:repro för ett bankkort (relation M-FAS): bas och variant körs om och
 * jämförs med samma comparePhase som bankspåret, och varje utslag klassas med
 * registret.
 *
 * Kortet skapades för ett kluster med ETT registerutfall (nyckeln i
 * fynd.json, i praktiken KANDIDAT). Svaret är KVAR bara när mekanismen
 * fortfarande ger ett utslag med kortets registerklass och post. Utslag av
 * samma mekanism med ett annat registerutfall (till exempel 42h-flashen som
 * KIE-PER-KORPUS godtar) gav inte kortet; de räknas och visas som
 * information, som i reproKalibrering. Rättat 2026-11-04 (runda 2, E4):
 * förut räknades varje utslag av mekanismen, så granskarens konstruerade
 * M-FAS-kort för 42h svarade KVAR fast den enda träffen var ACCEPTERAD.
 * @param {string} katalog - fyndkatalogen
 * @param {object} körning - {pool, register}
 * @returns {Promise<number>} exitkod (0 för KVAR/BORTA, 2 för KAN INTE DÖMAS)
 */
async function bankRepro(katalog, körning) {
  const recept = JSON.parse(fs.readFileSync(path.join(katalog, 'recept.json'), 'utf8'));
  const sparat = JSON.parse(fs.readFileSync(path.join(katalog, 'fynd.json'), 'utf8'));
  const utfall = kortetsRegisterutfall(sparat);
  if (!utfall) {
    console.log(`Repro ${path.basename(katalog)}: KAN INTE DÖMAS för ${sparat.mekanism || '(okänd mekanism)'} — fynd.json saknar kortets registerutfall (nyckeln)`);
    return 2;
  }
  const korpus = bankOps.corpusList([recept.korpus])[0];
  const kc = bankOps.readCorpus({ id: korpus.id, jsonl: path.join(katalog, 'bas.jsonl') });
  const variant = path.join(katalog, 'variant.jsonl');
  const vState = bankOps.statePathFor(variant);
  const [b, v] = await körning.pool.runAll([
    {
      jsonl: kc.jsonl, etikett: 'bas', monitoring: !!recept.monitoring, rader: kc.rader.length, simTimmar: kc.simTimmar,
    },
    {
      jsonl: variant, etikett: 'variant', monitoring: !!recept.monitoring, rader: kc.rader.length, simTimmar: kc.simTimmar,
    },
  ]);
  if (!b.ok) throw new Error(`basen kunde inte köras: ${b.fel}`);
  const base = selftest.baseEntry(korpus, kc, b);
  const fynd = relations.comparePhase(base, v, {
    deltaS: recept.deltaS,
    monitoring: !!recept.monitoring,
    fil: { jsonl: variant, statePath: fs.existsSync(vState) ? vState : null },
    h3Baslinje: health.buildH3Baseline([b]),
  });
  for (const f of fynd) f.register = körning.register.classify(f, f.kontext || {});
  const kort = fynd.filter((f) => !f.räknare);
  const träffar = kort.filter((f) => mechanismOf(f) === sparat.mekanism);
  // Bara utslag med kortets registerutfall (det som gav kortet) håller kortet kvar.
  const kvar = träffar.filter((f) => f.register.klass === utfall.klass && (f.register.post || null) === utfall.post);
  const andra = {};
  for (const f of träffar.filter((x) => !kvar.includes(x))) {
    const k = `${f.register.klass}${f.register.post ? ` ${f.register.post}` : ''}`;
    andra[k] = (andra[k] || 0) + 1;
  }
  const andraText = Object.entries(andra).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ');
  // En variant som inte kan köras kan inte jämföras med basen: KAN INTE
  // DÖMAS, aldrig BORTA (H1-kort reproducerar däremot just genom att fallera).
  const kanInte = !v.ok && !kvar.length;
  let svar = kvar.length ? 'KVAR' : 'BORTA';
  if (kanInte) svar = 'KAN INTE DÖMAS';
  const kortetsUtfall = `${utfall.klass}${utfall.post ? ` ${utfall.post}` : ''}`;
  console.log(`Repro ${path.basename(katalog)}: ${recept.korpus}, δ ${recept.deltaS} s${recept.monitoring ? ', REPLAY_MONITORING=1' : ''}`);
  console.log(`  sparad mekanism: ${sparat.mekanism} (kortets registerutfall ${kortetsUtfall})`);
  console.log(`  utfall mot aktuell HEAD: ${svar} (${kvar.length} utslag av mekanismen med registerutfallet ${kortetsUtfall}; `
    + `${träffar.length - kvar.length} med annat registerutfall, som information${andraText ? ` — ${andraText}` : ''}; `
    + `${kort.length} utslag i varianten${v.ok ? '' : `; körfel i varianten: ${v.fel}`})`);
  for (const f of kort) console.log(`  - ${f.orakel} ${f.klass} [${f.register.klass}${f.register.post ? ` ${f.register.post}` : ''}]: ${f.detalj}`);
  return kanInte ? 2 : 0;
}

registerLane({
  id: 'bank',
  fas: 1,
  titel: 'Bankspåret (M-FAS)',
  async kör(körning) {
    await selftest.ensureBase(körning);
    if (körning.stopp.length && !körning.flaggor.ignoreraSjälvtest) return körning;
    const { fynd, varianter } = await relations.runPhase(körning, { ensureBase: selftest.ensureBase });
    körning.fynd.push(...fynd);
    const rena = varianter.filter((v) => v.ren).length;
    körning.bank = { varianter, rena, totalt: varianter.length };
    // Nödbromsen: färre dömda varianter än planen (korpusar × δ × armar).
    const planerade = körning.korpusar.length * körning.profil.fasDeltaS.length * körning.profil.fasMonitoring.length;
    if (varianter.length < planerade) markeraAvkortad(körning, `fas 1 (bankspåret): ${varianter.length} av ${planerade} fasvarianter dömda`);
    for (const monitoring of körning.profil.fasMonitoring) {
      const vs = varianter.filter((v) => v.monitoring === monitoring);
      if (!vs.length) continue;
      körning.täckning.rader.push({
        spår: 'bank', orakel: `M-FAS${monitoring ? ' (REPLAY_MONITORING=1)' : ''}`, profil: körning.profil.namn, prövat: vs.length, utslag: vs.filter((v) => !v.ren).length,
      });
    }
    return körning;
  },
  slåIhop: (fynd, körning) => relations.mergePhaseFindings(fynd, körning.profil.fasDeltaS),
  repro: bankRepro,
  sammanfattning(körning) {
    const b = körning.bank;
    if (!b) return 'Bankspåret: kördes inte.';
    const kandidater = (körning.kluster || []).filter((c) => c.registerklass === 'KANDIDAT' && (c.fördelning.spår || {}).bank && !c.låstBank).length;
    const kända = (körning.kluster || []).filter((c) => c.registerklass !== 'KANDIDAT' && (c.fördelning.spår || {}).bank).length;
    const mon = körning.profil.fasMonitoring.includes(true) ? ', även med REPLAY_MONITORING=1' : '';
    return `Bankspåret: ${b.totalt} fasvarianter (δ = ${körning.profil.fasDeltaS.map(fmtDelta).join(', ')} s${mon}), ${b.rena} rena; `
      + `${kandidater} kandidatkluster (KNIVSEGG) och ${kända} kluster med registerpost.${avkortadIFas(körning, 1) ? ' AVKORTAD av nödbromsen.' : ''}`;
  },
});

// ---------------------------------------------------------------------------
// Upptäckt av fler spår (lib/lanes/*.js)
// ---------------------------------------------------------------------------

function discoverLanes(dir = path.join(__dirname, 'lanes')) {
  const loaded = [];
  if (!fs.existsSync(dir)) return loaded;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    // eslint-disable-next-line global-require
    const mod = require(path.join(dir, file));
    const lane = mod && mod.id ? mod : mod && mod.lane;
    if (lane) loaded.push(registerLane(lane).id);
  }
  return loaded;
}

function getLane(id) {
  return LANES.get(id) || null;
}

function listLanes() {
  return [...LANES.values()].sort((a, b) => (a.fas - b.fas) || (a.id < b.id ? -1 : 1));
}

module.exports = {
  KNOWN_IDS, registerLane, discoverLanes, getLane, listLanes, bankRepro, kortetsRegisterutfall,
};
