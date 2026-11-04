'use strict';

/**
 * Buggjägaren v1 — en motor som bara RAPPORTERAR (docs/BUGGJAKT.md).
 *
 * Föräldern (den här processen, äkta klocka) genererar, dömer, klustrar och
 * skriver rapporten; all replay körs i barnprocesser mot det oförändrade
 * replayRunner-CLI:t (lib/pool.js). Faserna:
 *
 *   Fas 0  Självtest: git-vakt · banken ×2 · M-EXAKT · instrumentkrav · H3-baslinje,
 *          plus sanningsspårets tillägg: kanarier · rundresa · S-KALIBRERING · realism
 *   Fas 1  Bankspåret: fasrelationen M-FAS
 *   Fas 2  Sanningsspåret (lib/lanes/synth.js, upptäcks automatiskt)
 *   Fas 3  Register → mekanismkluster
 *   Fas 4  Krympning på specnivå och bekräftelse (spår med krympAlla/krymp)
 *   Fas 5  Rapport: rapport.md · rapport.json · fynd/Fnn-<slug>/ och fynd/Bnn-<post>/
 *
 * Exitkoder: 0 när motorn körde klart (även med fynd), 1 vid felaktig
 * användning, 2 vid självtest- eller motorfel (och när git-vakten eller
 * kontrollen av utkatalogen fäller). hunt:repro svarar KVAR eller BORTA med
 * exit 0 och KAN INTE DÖMAS med exit 2.
 * Motorn ingår medvetet INTE i `npm run validate`: den är ett diagnosverktyg,
 * inte en grind. Den rättar ingenting, låser aldrig om facit, sätter aldrig
 * REGEN_*-variabler och ändrar inte beslutsregistret.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hygiene = require('./lib/hygiene');
const profiles = require('./lib/profiles');
const bankOps = require('./lib/bankOps');
const { Pool } = require('./lib/pool');
const registryLib = require('./lib/registry');
const clusterLib = require('./lib/cluster');
const report = require('./lib/report');
const lanes = require('./lib/lanes');
const existing = require('./lib/oracles/existing');
const health = require('./lib/oracles/health');
const { makeFinding, mechanismOf } = require('./lib/finding');

const MOTORVERSION = '1.0.0';
const PLANTS = Object.freeze(['skip-state-shift', 'skip-state-relabel']);
const CALIBRATION = path.join(__dirname, 'calibration.json');

const USAGE = `Användning: node tests/replay-validation/bugHunt/hunt.js [flaggor]

  --profile=quick|standard|night   profil (standard)
  --worlds=N                       budget i antal världar (sanningsspåret)
  --seed=S                         bas-seed (1)
  --corpus=id,…                    delmängd för bankspåret (självtestet märks "delmängd")
  --lanes=selftest,bank,synth      vilka spår som körs (alla)
  --families=F-KÖ,…                familjer (sanningsspåret)
  --radio=R0,R1                    radioprofiler (sanningsspåret)
  --jobs=N                         parallellitet (min(4, antal CPU))
  --out=KATALOG                    utkatalog (dirigent/hunt/… eller os.tmpdir()); tom, ny eller en tidigare
                                   motorkörning, och i övrigt bara loggfiler (*.log)
  --max-minutes=M                  nödbroms; rapporten märks AVKORTAD
  --no-shrink                      hoppa över krympningen
  --keep-temp                      behåll tempfilerna
  --selftest                       bara fas 0
  --repro=KATALOG                  kör om ett sparat fynd mot aktuell HEAD
                                   (KVAR/BORTA, eller KAN INTE DÖMAS med exit 2)
  --ignore-selftest, --plant=…     utvecklarflaggor (${PLANTS.join(', ')})
  --help                           den här texten`;

// ---------------------------------------------------------------------------
// Flaggor
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const f = {
    profil: 'standard',
    världar: null,
    seed: 1,
    korpus: null,
    spår: null,
    familjer: null,
    radio: null,
    jobb: Math.max(1, Math.min(4, os.cpus().length || 1)),
    ut: null,
    maxMinuter: null,
    ingenKrympning: false,
    behållTemp: false,
    repro: null,
    självtest: false,
    ignoreraSjälvtest: false,
    plantera: [],
    hjälp: false,
  };
  const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  const posInt = (name, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} kräver ett positivt heltal (fick "${v}")`);
    return n;
  };
  const args = [...argv];
  try {
    while (args.length) {
      const a = args.shift();
      const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
      if (!m) {
        if (f.repro === true) {
          f.repro = a;
          continue;
        }
        throw new Error(`okänt argument "${a}"`);
      }
      const [, name, value] = m;
      const need = () => {
        if (value === undefined || value === '') throw new Error(`--${name} kräver ett värde (--${name}=…)`);
        return value;
      };
      switch (name) {
        case 'profile': f.profil = need(); profiles.getProfile(f.profil); break;
        case 'worlds': f.världar = posInt(name, need()); break;
        case 'seed': {
          const n = Number(need());
          if (!Number.isInteger(n) || n < 0) throw new Error(`--seed kräver ett heltal ≥ 0 (fick "${value}")`);
          f.seed = n;
          break;
        }
        case 'corpus': f.korpus = list(need()); bankOps.corpusList(f.korpus); break;
        case 'lanes': f.spår = list(need()); break;
        case 'families': f.familjer = list(need()); break;
        case 'radio': f.radio = list(need()); break;
        case 'jobs': f.jobb = posInt(name, need()); break;
        case 'out': f.ut = need(); break;
        case 'max-minutes': {
          const n = Number(need());
          if (!(n > 0)) throw new Error(`--max-minutes kräver ett positivt tal (fick "${value}")`);
          f.maxMinuter = n;
          break;
        }
        case 'no-shrink': f.ingenKrympning = true; break;
        case 'keep-temp': f.behållTemp = true; break;
        case 'repro': f.repro = value === undefined ? true : value; break;
        case 'selftest': f.självtest = true; break;
        case 'ignore-selftest': f.ignoreraSjälvtest = true; break;
        case 'plant': {
          const ps = list(need());
          const bad = ps.filter((p) => !PLANTS.includes(p));
          if (bad.length) throw new Error(`okänd --plant=${bad.join(',')} (kända: ${PLANTS.join(', ')})`);
          f.plantera.push(...ps);
          break;
        }
        case 'help': f.hjälp = true; break;
        default: throw new Error(`okänd flagga --${name}`);
      }
    }
    if (f.repro === true) throw new Error('--repro kräver en fyndkatalog (--repro=KATALOG eller --repro KATALOG)');
    if (f.självtest && f.spår && f.spår.join(',') !== 'selftest') throw new Error('--selftest kan inte kombineras med --lanes');
    if (f.självtest) f.spår = ['selftest'];
  } catch (e) {
    return { flaggor: f, fel: e.message };
  }
  return { flaggor: f, fel: null };
}

// ---------------------------------------------------------------------------
// Körningsobjektet
// ---------------------------------------------------------------------------

function calibrationHash() {
  if (!fs.existsSync(CALIBRATION)) return 'okalibrerad';
  return crypto.createHash('sha256').update(fs.readFileSync(CALIBRATION)).digest('hex').slice(0, 12);
}

/**
 * Bygger körningsobjektet — det objekt som passerar mellan faserna.
 * @param {object} flaggor - tolkade flaggor
 * @param {{borttagna: string[], start: number}} env - miljöskrubbets utfall
 * @returns {object} körning
 */
function createRun(flaggor, { borttagna, start }) {
  const profil = profiles.getProfile(flaggor.profil);
  const gitFöre = hygiene.gitInfo();
  const körningsId = hygiene.runIdOf({
    sha: gitFöre.sha, kalibrering: calibrationHash(), motorversion: MOTORVERSION, profil: profil.namn, seed: flaggor.seed,
  });
  const ut = hygiene.resolveOutDir({
    gitLäge: gitFöre, profil: profil.namn, seed: flaggor.seed, out: flaggor.ut, now: new Date(start),
  });
  const deadline = flaggor.maxMinuter ? start + flaggor.maxMinuter * 60000 : null;
  const körning = {
    motorversion: MOTORVERSION,
    flaggor,
    flaggorDeterministiska: {
      profil: profil.namn,
      världar: flaggor.världar || profil.världar,
      seed: flaggor.seed,
      korpus: flaggor.korpus,
      spår: flaggor.spår,
      familjer: flaggor.familjer,
      radio: flaggor.radio,
      ingenKrympning: flaggor.ingenKrympning,
      plantera: flaggor.plantera,
      maxMinuter: flaggor.maxMinuter,
    },
    profil,
    seed: flaggor.seed,
    världar: flaggor.världar || profil.världar,
    rot: hygiene.REPO_ROOT,
    git: { före: gitFöre, efter: null, vakt: null },
    körningsId,
    ut,
    temp: null,
    pool: null,
    register: null,
    korpusar: bankOps.corpusList(flaggor.korpus),
    delmängd: !!(flaggor.korpus && flaggor.korpus.length),
    spår: [],
    bas: null,
    basMonitoring: null,
    fynd: [],
    kluster: [],
    hälsa: { varningar: [...ut.varningar] },
    täckning: { rader: [], räknare: {}, saknadeSpår: [] },
    självtestTillägg: [],
    sammanfattning: [],
    stopp: [],
    motorfel: [],
    avkortad: false,
    avkortning: [],
    plantera: flaggor.plantera,
    miljö: { borttagna },
    tid: { start: new Date(start).toISOString(), perFas: {} },
    tidenUte: () => (deadline !== null && Date.now() > deadline),
    stoppa(fas, skäl) {
      this.stopp.push(`fas ${fas}: ${skäl}`);
    },
  };
  return körning;
}

/** Väljer spår enligt --lanes (standard: alla kända). */
function selectLanes(körning) {
  const requested = körning.flaggor.spår || lanes.KNOWN_IDS;
  const explicit = !!körning.flaggor.spår;
  const chosen = [];
  for (const id of requested) {
    const lane = lanes.getLane(id);
    if (lane) chosen.push(lane);
    else if (explicit) throw Object.assign(new Error(`spåret "${id}" är inte inkopplat i den här versionen (inkopplade: ${lanes.listLanes().map((l) => l.id).join(', ')})`), { användning: true });
    else körning.täckning.saknadeSpår.push(id);
  }
  return chosen.sort((a, b) => (a.fas - b.fas) || (a.id < b.id ? -1 : 1));
}

async function timed(körning, fas, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    körning.tid.perFas[fas] = (körning.tid.perFas[fas] || 0) + (Date.now() - t0);
  }
}

// ---------------------------------------------------------------------------
// Fas 3: register → kluster
// ---------------------------------------------------------------------------

function classifyAndCluster(körning, chosen) {
  const reg = körning.register;
  for (const f of körning.fynd) {
    // Sanningsspåret klassar sina fynd direkt i världen (kontexten är för
    // stor att spara för tusentals världar); de klassas inte om här.
    if (f.register) continue;
    const c = reg.classify(f, f.kontext || {});
    f.register = {
      klass: c.klass, post: c.post, närmast: c.närmast, skäl: c.skäl, prövade: (c.prövade || []).slice(0, 4),
    };
    if (c.taggar.length) f.taggar = [...new Set([...(f.taggar || []), ...c.taggar])].sort();
  }
  let all = körning.fynd;
  for (const lane of chosen) {
    if (typeof lane.slåIhop !== 'function') continue;
    const mine = all.filter((f) => f.spår === lane.id);
    const rest = all.filter((f) => f.spår !== lane.id);
    all = [...rest, ...lane.slåIhop(mine, körning)];
  }
  const counters = all.filter((f) => f.räknare);
  for (const f of counters) {
    const k = `${f.orakel} ${f.klass}${f.spår ? ` (${f.spår})` : ''}`;
    körning.täckning.räknare[k] = (körning.täckning.räknare[k] || 0) + 1;
  }
  körning.fynd = all;
  körning.kluster = clusterLib.clusterFindings(all.filter((f) => !f.räknare));
  return körning;
}

// ---------------------------------------------------------------------------
// Sammanfattning och hälsotexter
// ---------------------------------------------------------------------------

function finishHealth(körning) {
  const h = körning.hälsa;
  const g = körning.git;
  const plats = körning.ut.källa === 'dirigent' ? 'dirigent/hunt/ (git-ignorerad)' : 'utanför repot eller ignorerad';
  if (!g.före.finns) {
    h.git = { ok: true, text: `git saknas (${g.före.skäl}) — vakten varnar i stället för att stoppa; utkatalogen ligger i ${körning.ut.källa === 'tmpdir' ? 'os.tmpdir()' : 'angiven katalog'}` };
  } else if (g.vakt && !g.vakt.ok) {
    h.git = { ok: false, text: `git status ÄNDRADES under körningen: ${g.vakt.skillnad.join('; ')}` };
  } else {
    h.git = { ok: true, text: `git status --porcelain oförändrad; utkatalogen är ${plats}` };
  }
  h.miljö = { borttagna: körning.miljö.borttagna, text: körning.miljö.borttagna.length ? `borttagna variabler: ${körning.miljö.borttagna.join(', ')}` : 'inga variabler behövde tas bort' };
  if (!h.självtest) h.självtest = { status: 'EJ KÖRT', text: 'självtestet ingick inte i --lanes', stopp: [...körning.stopp] };
  else h.självtest.stopp = [...körning.stopp];
  if (körning.stopp.length && h.självtest.status === 'GRÖNT') h.självtest.status = körning.flaggor.ignoreraSjälvtest ? 'RÖTT (ignorerat med --ignore-selftest)' : 'RÖTT';
  const rader = körning.korpusar.reduce((s, c) => s + ((körning.bas && körning.bas.get(c.id)) ? körning.bas.get(c.id).kc.rader.length : 0), 0);
  const timmar = körning.korpusar.reduce((s, c) => s + ((körning.bas && körning.bas.get(c.id)) ? körning.bas.get(c.id).kc.simTimmar : 0), 0);
  const { synt } = körning.täckning;
  const syntText = synt
    ? `; ${synt.världar} syntetiska världar (${Object.entries(synt.perProfil).map(([p, v]) => `${p} ${v}`).join(', ')}; `
      + `${Object.entries(synt.perNivå).map(([p, v]) => `${p} ${v}`).join(', ')}) med ${report.fmtNum(synt.simTimmar, 1)} simulerade timmar och ${report.fmtInt(synt.rader)} rader`
    : '';
  körning.underlag = {
    korpusar: körning.korpusar.length,
    rader,
    simTimmar: Math.round(timmar * 100) / 100,
    text: `${körning.korpusar.length} korpusar${körning.delmängd ? ' (delmängd)' : ''}, ${report.fmtNum(timmar, 1)} simulerade timmar, `
      + `${report.fmtInt(rader)} rader${körning.bank ? `; ${körning.bank.totalt} fasvarianter` : ''}${syntText}`,
  };
}

/**
 * Sammanfattningens rader (rapport.md och rapport.json). En AVKORTAD körning
 * får en första rad som säger var nödbromsen slog till.
 * @param {object} körning - körningsobjektet efter fas 4
 * @param {object[]} chosen - de valda spåren
 */
function summarize(körning, chosen) {
  const st = körning.hälsa.självtest;
  const lines = [];
  if (körning.avkortad) {
    const skäl = (körning.avkortning || []).length ? körning.avkortning.join('; ') : 'okänd fas';
    const max = körning.flaggor && körning.flaggor.maxMinuter ? `=${report.fmtNum(körning.flaggor.maxMinuter)}` : '';
    lines.push(`AVKORTAD av nödbromsen (--max-minutes${max}): ${skäl}. Rapporten beror på väggklockan och är inte reproducerbar.`);
  }
  lines.push(`Självtest: ${st.status}${st.text ? ` — ${st.text}` : ''}.`);
  const ids = new Set(chosen.map((l) => l.id));
  const bank = lanes.getLane('bank');
  if (ids.has('bank')) lines.push(bank.sammanfattning(körning));
  else lines.push('Bankspåret: ingick inte i --lanes.');
  const synth = lanes.getLane('synth');
  if (synth && ids.has('synth') && typeof synth.sammanfattning === 'function') lines.push(synth.sammanfattning(körning));
  else if (körning.täckning.saknadeSpår.includes('synth')) lines.push('Sanningsspåret: ej inkopplat i den här versionen (byggs separat; rapportens täckningsruta visar vad som inte prövades).');
  else lines.push('Sanningsspåret: ingick inte i --lanes.');
  for (const lane of chosen) {
    if (['selftest', 'bank', 'synth'].includes(lane.id) || typeof lane.sammanfattning !== 'function') continue;
    lines.push(lane.sammanfattning(körning));
  }
  körning.sammanfattning = lines;
}

// ---------------------------------------------------------------------------
// Huvudflödet
// ---------------------------------------------------------------------------

async function runHunt(flaggor, borttagna) {
  const start = Date.now();
  const körning = createRun(flaggor, { borttagna, start });
  const log = (s) => console.log(s);
  log(`Buggjägaren ${MOTORVERSION} — profil ${körning.profil.namn}, seed ${körning.seed}, ${flaggor.jobb} jobb, körnings-id ${körning.körningsId}`);
  if (körning.ut.fel) {
    console.error(`S-GIT: ${körning.ut.fel}`);
    return 2;
  }
  // En icke-tom utkatalog godtas bara när den innehåller en tidigare
  // motorkörning och i övrigt bara loggfiler (*.log, som lämnas orörda);
  // körningen töms då precis före skrivningen (report.writeReport).
  const utLäge = hygiene.checkOutDir(körning.ut.dir, { format: report.FORMAT });
  if (!utLäge.ok) {
    console.error(`Utkatalog: ${utLäge.fel}`);
    return 2;
  }
  for (const v of körning.ut.varningar) log(`  varning: ${v}`);
  log(`Utkatalog: ${körning.ut.dir}${utLäge.tidigare ? ' (en tidigare motorkörning där ersätts: fynd/, rapport.md och rapport.json töms före skrivningen)' : ''}`);
  let exit = 0;
  try {
    körning.register = registryLib.loadRegistry();
    lanes.discoverLanes();
    const chosen = selectLanes(körning);
    // Spårens egna flaggor (--families, --radio) prövas innan något körs.
    for (const lane of chosen) if (typeof lane.kontrollera === 'function') lane.kontrollera(flaggor);
    körning.spår = chosen.map((l) => l.id);
    // Fas 0 omfattar alla inkopplade spårs självtesttillägg (kanarier,
    // rundresa, S-KALIBRERING), även när spåret självt inte körs — så att
    // `--selftest` prövar hela instrumentet.
    for (const lane of lanes.listLanes()) if (typeof lane.självtest === 'function') körning.självtestTillägg.push(lane.självtest);
    körning.temp = hygiene.makeTempDir(körning.körningsId);
    fs.mkdirSync(path.join(körning.temp, 'run'), { recursive: true });
    körning.pool = new Pool({ jobb: flaggor.jobb, tmpDir: path.join(körning.temp, 'run') });

    for (const lane of chosen) {
      if (lane.fas > 0 && körning.stopp.length && !flaggor.ignoreraSjälvtest) {
        log(`Fas ${lane.fas} (${lane.titel}): hoppas över — självtestet stoppade jakten.`);
        continue;
      }
      if (lane.fas > 0 && körning.tidenUte()) {
        report.markeraAvkortad(körning, `fas ${lane.fas} (${lane.titel}): hoppades över`);
        log(`Fas ${lane.fas} (${lane.titel}): hoppas över — nödbromsen (--max-minutes).`);
        continue;
      }
      const t0 = Date.now();
      const avkortadFöre = körning.avkortad;
      // eslint-disable-next-line no-await-in-loop
      await timed(körning, `fas${lane.fas}-${lane.id}`, () => lane.kör(körning));
      // Ett spår som bara sätter flaggan (utan skäl) får ett generiskt skäl.
      if (körning.avkortad && !avkortadFöre && !report.avkortadIFas(körning, lane.fas)) {
        report.markeraAvkortad(körning, `fas ${lane.fas} (${lane.titel}): nödbromsen avbröt efter det sammanhängande prefixet`);
      }
      log(`Fas ${lane.fas} (${lane.titel}): klar på ${report.fmtNum((Date.now() - t0) / 1000, 1)} s`);
      if (lane.id === 'selftest') {
        const st = körning.hälsa.självtest;
        log(`  ${st.status}: ${st.text}`);
        for (const s of körning.stopp) log(`  STOPP ${s}`);
      }
      if (lane.id === 'bank' && körning.bank) log(`  ${körning.bank.totalt} fasvarianter, ${körning.bank.rena} rena`);
      if (lane.id === 'synth' && körning.täckning.synt) {
        const st = körning.täckning.synt;
        log(`  ${st.världar} världar (${Object.entries(st.perProfil).map(([p, v]) => `${p} ${v}`).join(', ')}), ${report.fmtNum(st.simTimmar, 1)} simulerade timmar, ${st.fel} fel, ${st.häng} häng`);
      }
    }

    await timed(körning, 'fas3-register', () => classifyAndCluster(körning, chosen));
    const nKand = körning.kluster.filter((c) => c.registerklass === 'KANDIDAT').length;
    log(`Fas 3 (register → kluster): ${körning.fynd.filter((f) => !f.räknare).length} utslag → ${körning.kluster.length} kluster (${nKand} kandidater)`);

    {
      const { kluster: n, perKluster } = körning.profil.representanter;
      // Nödbromsen prövas före fas 4: är tiden redan slut krymps ingenting
      // (korten får bara tidslinjer ur de sparade världarna) och rapporten
      // märks AVKORTAD. Med --no-shrink eller utan krympande spår finns
      // ingenting att korta.
      const krymperFas4 = !flaggor.ingenKrympning && chosen.some((l) => typeof l.krympAlla === 'function' || typeof l.krymp === 'function');
      const slutFöreFas4 = krymperFas4 && !(körning.stopp.length && !flaggor.ignoreraSjälvtest) && körning.tidenUte();
      if (slutFöreFas4) {
        report.markeraAvkortad(körning, 'fas 4 (krympning och bekräftelse): hoppades över, tiden var slut före fasen');
        log('Fas 4 (krympning och bekräftelse): hoppas över — nödbromsen (--max-minutes).');
      }
      for (const lane of chosen) {
        if (körning.stopp.length && !flaggor.ignoreraSjälvtest) break;
        if (typeof lane.krympAlla === 'function') {
          // Spåret väljer själv sina kluster och representanter, krymper dem
          // parallellt i poolen och bekräftar (med --no-shrink eller när
          // nödbromsen redan slagit till: bara kortens tidslinjer, ingen replay).
          const t4 = Date.now();
          const krymp = !flaggor.ingenKrympning && !slutFöreFas4;
          // eslint-disable-next-line no-await-in-loop
          await timed(körning, `fas4-${lane.id}`, () => lane.krympAlla(körning, {
            n, perKluster, krymp, nödbroms: slutFöreFas4,
          }));
          const k = körning.täckning.krympning;
          if (k && krymp) {
            const avk = (k.nödbroms || k.obekräftade) ? ` — AVKORTAD (${k.nödbroms || 0} delvis krympta av nödbromsen, ${k.obekräftade || 0} obekräftade)` : '';
            log(`Fas 4 (krympning och bekräftelse, ${lane.id}): ${k.krympta} av ${k.representanter} representanter `
              + `på ${report.fmtNum((Date.now() - t4) / 1000, 1)} s (${k.prov} prov)${avk}`);
          }
          continue;
        }
        if (slutFöreFas4 || flaggor.ingenKrympning || typeof lane.krymp !== 'function') continue;
        const mine = körning.kluster.filter((c) => (c.fördelning.spår || {})[lane.id]).slice(0, n);
        for (const c of mine) {
          // eslint-disable-next-line no-await-in-loop
          await timed(körning, `fas4-${lane.id}`, () => lane.krymp(körning, c, clusterLib.chooseRepresentatives(c, perKluster)));
        }
      }
    }

    körning.git.efter = hygiene.gitInfo();
    körning.git.vakt = hygiene.compareGit(körning.git.före, körning.git.efter);
    finishHealth(körning);
    summarize(körning, chosen);
    const slut = Date.now();
    körning.tid.slut = new Date(slut).toISOString();
    körning.tid.väggtidMs = slut - start;
    körning.tid.pool = körning.pool.statistik;
    körning.tid.utkatalog = körning.ut.dir;
    const { perKluster } = körning.profil.representanter;
    const written = report.writeReport(körning, { representanter: (c) => c.representanter || clusterLib.chooseRepresentatives(c, perKluster) });
    log(`Fas 5 (rapport): ${written.md}`);
    for (const line of körning.sammanfattning) log(`  ${line}`);
    if (körning.stopp.length && !flaggor.ignoreraSjälvtest) exit = 2;
    if (körning.git.vakt && !körning.git.vakt.ok) exit = 2;
    const after = hygiene.gitInfo();
    const final = hygiene.compareGit(körning.git.före, after);
    if (!final.ok) {
      console.error(`S-GIT: git status ändrades av körningen: ${final.skillnad.join('; ')}`);
      fs.appendFileSync(written.md, `\n## GIT-VAKTEN FÄLLDE\n\n${final.skillnad.map((s) => `- ${s}`).join('\n')}\n`);
      exit = 2;
    }
  } catch (e) {
    if (e.användning) {
      console.error(`Fel: ${e.message}\n\n${USAGE}`);
      exit = 1;
    } else {
      console.error(`MOTORFEL: ${e.stack || e.message}`);
      exit = 2;
    }
  } finally {
    if (körning.temp && !flaggor.behållTemp) hygiene.removeDir(körning.temp);
    else if (körning.temp) log(`Tempfilerna behålls: ${körning.temp}`);
  }
  return exit;
}

// ---------------------------------------------------------------------------
// hunt:repro
// ---------------------------------------------------------------------------

/** Orakel som harnessens befintliga domare (oracles/existing.js) dömer. */
const BEFINTLIGA_ORAKEL = Object.freeze(['INV-F', 'INV-W', 'LEV']);
/** Hälsoorakel som döms direkt ur poolens utfall (oracles/health.js). */
const HÄLSO_ORAKEL = Object.freeze(['H1', 'H2', 'H3']);
/** Exitkoden för KAN INTE DÖMAS. */
const EXIT_KAN_INTE_DÖMAS = 2;

/**
 * Väljer domaren för ett sparat kort (BUGGJAKT §10). Ett kort döms om av
 * samma domare som skapade det:
 *   spår         recept.spår (sanningsspåret) eller relationen M-FAS (bankspåret)
 *   S-KALIBRERING  T1/T10 mot banksanningen och registret, som i självtestet
 *   S-KANARIE    kanariekontrollen (selftestSynth.checkCanary)
 *   hälsa        H1–H3 ur poolens utfall (H3 absolut: signaturen ska inte finnas)
 *   befintliga   harnessens domare (INV-F, INV-W, LEV) på kortets jsonl
 * Finns ingen domare blir svaret KAN INTE DÖMAS (exit 2), aldrig BORTA.
 * @param {object} recept - recept.json ({} när filen saknas)
 * @param {object} sparat - fynd.json ({mekanism, nyckel, fynd})
 * @returns {{id: string|null, spår?: string, skäl?: string}} domaren eller skälet att den saknas
 */
function reproDomare(recept, sparat) {
  const r = recept || {};
  const orakel = String((sparat && sparat.mekanism) || '').split('|')[0];
  const laneId = r.spår || (r.relation === 'M-FAS' ? 'bank' : null);
  if (laneId) {
    const lane = lanes.getLane(laneId);
    if (lane && typeof lane.repro === 'function') return { id: 'spår', spår: laneId };
    return { id: null, skäl: `spåret ${laneId} är inte inkopplat eller saknar hunt:repro` };
  }
  if (r.relation === 'S-KALIBRERING') {
    if (!['T1', 'T10'].includes(orakel)) return { id: null, skäl: `S-KALIBRERING dömer bara T1 och T10, inte ${orakel || 'ett okänt orakel'}` };
    return { id: 'S-KALIBRERING' };
  }
  if (r.relation === 'S-KANARIE' || orakel === 'S-KANARIE') return { id: 'S-KANARIE' };
  if (r.relation && r.relation !== 'BAS') return { id: null, skäl: `relationen ${r.relation} har ingen domare i hunt:repro` };
  if (HÄLSO_ORAKEL.includes(orakel)) return { id: 'hälsa' };
  if (BEFINTLIGA_ORAKEL.includes(orakel)) return { id: 'befintliga' };
  return { id: null, skäl: `ingen domare för oraklet ${orakel || '(okänt)'}${r.relation ? ` i relationen ${r.relation}` : ''}` };
}

/** Skriver KAN INTE DÖMAS och returnerar dess exitkod. */
function kanInteDöma(namn, mekanism, skäl) {
  console.log(`Repro ${namn}: KAN INTE DÖMAS för ${mekanism || '(okänd mekanism)'} — ${skäl}`);
  return EXIT_KAN_INTE_DÖMAS;
}

/** Fyndkatalogens jsonl att köra (repro, bas eller variant), eller null. */
function reproJsonl(dir) {
  return ['repro.jsonl', 'bas.jsonl', 'variant.jsonl'].map((f) => path.join(dir, f)).find((p) => fs.existsSync(p)) || null;
}

/**
 * Körningsobjektet för hunt:repro: register, tempkatalog och pool. Ingen
 * git-vakt och ingen utkatalog — repro skriver bara i tempkatalogen.
 * @param {object} flaggor - tolkade flaggor
 * @param {{pool?: object}} [deps] - injicerad pool (jest)
 * @returns {object} körning
 */
function reproKörning(flaggor, { pool = null } = {}) {
  const temp = hygiene.makeTempDir('repro');
  fs.mkdirSync(path.join(temp, 'run'), { recursive: true });
  return {
    motorversion: MOTORVERSION,
    flaggor,
    profil: profiles.getProfile(flaggor.profil || 'quick'),
    seed: flaggor.seed,
    register: registryLib.loadRegistry(),
    temp,
    pool: pool || new Pool({ jobb: flaggor.jobb, tmpDir: path.join(temp, 'run') }),
    hälsa: { varningar: [] },
    täckning: { rader: [], räknare: {}, saknadeSpår: [] },
    fynd: [],
    stopp: [],
    avkortad: false,
    avkortning: [],
    tidenUte: () => false,
    stoppa(fas, skäl) {
      this.stopp.push(`fas ${fas}: ${skäl}`);
    },
  };
}

/**
 * hälsa och befintliga: kör kortets jsonl en gång och dömer absolut.
 * Ett låst bankkort (relation BAS) bortser från korpusens
 * knownInvariantExceptions, som självtestet gör.
 */
async function reproDirekt(dir, körning, { domare, sparat, recept }) {
  const namn = path.basename(dir);
  const jsonl = reproJsonl(dir);
  if (!jsonl) return kanInteDöma(namn, sparat.mekanism, 'katalogen saknar en jsonl att köra');
  const [u] = await körning.pool.runAll([{ jsonl, etikett: path.basename(jsonl) }]);
  let fynd;
  let domText;
  if (domare.id === 'hälsa') {
    domText = 'hälsooraklen H1–H3 (H3 absolut)';
    fynd = [...health.h2(u), ...health.h1(u), ...health.h3((u.stderr && u.stderr.h3) || {}, null, { simTimmar: u.simTimmar || 1, exempel: (u.stderr && u.stderr.exempel) || {} })];
    if (!u.ok && !u.fatal && !u.häng) {
      fynd.push(makeFinding({
        orakel: 'H1', klass: 'PROCESSFEL inget resultat', allvar: health.H1_SEVERITY, detalj: u.fel || 'inget resultat', belägg: { fel: u.fel },
      }));
    }
  } else {
    if (!u.ok) return kanInteDöma(namn, sparat.mekanism, `körfel: ${u.fel}`);
    domText = 'befintliga domare INV-F, INV-W och LEV';
    const korpus = recept.relation === 'BAS' && recept.korpus ? bankOps.corpusList().find((c) => c.id === recept.korpus) : null;
    const kie = korpus && Array.isArray(korpus.knownInvariantExceptions) ? korpus.knownInvariantExceptions : [];
    const rows = bankOps.readCorpus({ id: 'repro', jsonl }).rader;
    fynd = existing.judgeExisting({ result: u.resultat, rows, gt: null }).fynd
      .filter((f) => !(f.orakel === 'INV-F' && kie.some((k) => f.detalj.startsWith(k))));
  }
  const kort = fynd.filter((f) => !f.räknare);
  const kvar = kort.filter((f) => mechanismOf(f) === sparat.mekanism);
  console.log(`Repro ${namn} (${path.basename(jsonl)}): ${kvar.length ? 'KVAR' : 'BORTA'} för ${sparat.mekanism} — ${domText}${u.ok ? '' : `; körfel: ${u.fel}`}`);
  for (const f of kort) console.log(`  - ${f.orakel} ${f.klass}: ${f.detalj}`);
  return 0;
}

/**
 * hunt:repro: kör om ett sparat fynd mot aktuell HEAD och svarar KVAR eller
 * BORTA (exit 0), eller KAN INTE DÖMAS (exit 2) när motorn saknar domare för
 * kortet eller inte kan köra det.
 * @param {object} flaggor - tolkade flaggor (flaggor.repro = katalogen)
 * @param {string[]} borttagna - miljöskrubbets utfall (oanvänt här)
 * @param {{pool?: object}} [deps] - injicerad pool (jest)
 * @returns {Promise<number>} exitkod
 */
async function runRepro(flaggor, borttagna, deps = {}) {
  const dir = path.resolve(flaggor.repro);
  const namn = path.basename(dir);
  if (!fs.existsSync(path.join(dir, 'fynd.json'))) {
    console.error(`Fel: ${dir} är ingen fyndkatalog (fynd.json saknas)\n\n${USAGE}`);
    return 1;
  }
  let recept;
  let sparat;
  try {
    recept = fs.existsSync(path.join(dir, 'recept.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'recept.json'), 'utf8')) : {};
    sparat = JSON.parse(fs.readFileSync(path.join(dir, 'fynd.json'), 'utf8'));
  } catch (e) {
    console.error(`Fel: ${dir} har trasig fynd.json eller recept.json (${e.message})`);
    return 1;
  }
  lanes.discoverLanes();
  const domare = reproDomare(recept, sparat);
  if (!domare.id) return kanInteDöma(namn, sparat.mekanism, domare.skäl);
  const körning = reproKörning(flaggor, deps);
  try {
    if (domare.id === 'spår') return await lanes.getLane(domare.spår).repro(dir, körning);
    if (domare.id === 'S-KALIBRERING' || domare.id === 'S-KANARIE') {
      const synth = lanes.getLane('synth');
      const fn = synth && (domare.id === 'S-KALIBRERING' ? synth.reproKalibrering : synth.reproKanarie);
      if (typeof fn !== 'function') return kanInteDöma(namn, sparat.mekanism, `${domare.id} kräver sanningsspåret, som inte är inkopplat`);
      return await fn(dir, körning, { sparat, recept });
    }
    return await reproDirekt(dir, körning, { domare, sparat, recept });
  } catch (e) {
    console.error(e.stack || e.message);
    return kanInteDöma(namn, sparat.mekanism, `motorfel: ${e.message}`);
  } finally {
    if (!flaggor.behållTemp) hygiene.removeDir(körning.temp);
    else console.log(`Tempfilerna behålls: ${körning.temp}`);
  }
}

async function main(argv) {
  const { flaggor, fel } = parseArgs(argv);
  if (fel) {
    console.error(`Fel: ${fel}\n\n${USAGE}`);
    return 1;
  }
  if (flaggor.hjälp) {
    console.log(USAGE);
    return 0;
  }
  const borttagna = hygiene.scrubOwnEnv();
  if (flaggor.repro) return runRepro(flaggor, borttagna);
  return runHunt(flaggor, borttagna);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(`MOTORFEL: ${e.stack || e.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  MOTORVERSION,
  USAGE,
  EXIT_KAN_INTE_DÖMAS,
  parseArgs,
  createRun,
  selectLanes,
  classifyAndCluster,
  summarize,
  reproDomare,
  runRepro,
  main,
};
