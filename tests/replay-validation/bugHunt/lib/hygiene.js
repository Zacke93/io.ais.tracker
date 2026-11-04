'use strict';

/**
 * Hygien per körning (BUGGJAKT §3): utkatalog, tempkatalog, git-vakt,
 * miljöskrubb och körnings-id.
 *
 * Motorn skriver ALDRIG i repot. Standardutkatalogen är ägarens git-ignorerade
 * arbetsmapp dirigent/hunt/; saknas git eller är dirigent/ inte ignorerad
 * används os.tmpdir()/ais-tracker-hunt/. Git är valfritt: utan git varnar
 * vakten i stället för att stoppa (ren Windows-miljö).
 *
 * senaste.txt skrivs bara i motorns egna baskataloger (källorna 'dirigent'
 * och 'tmpdir'). Med --out skrivs ingenting utanför utkatalogen, och en
 * icke-tom --out godtas bara när den innehåller en tidigare motorkörning
 * (som då töms innan den nya rapporten skrivs) och i övrigt bara loggfiler
 * (*.log), som lämnas orörda.
 *
 * Inga skalkonstruktioner: git anropas med spawnSync och argumentlista, och
 * alla sökvägar byggs med path.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** Repots rot: bugHunt/lib → bugHunt → replay-validation → tests → rot. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Prefix som aldrig får nå en barnprocess (eller föräldern själv). */
const SCRUB_PREFIXES = Object.freeze([
  'REPLAY_', 'AIS_REPLAY_', 'AISHUB_POLL_CAPTURE', 'REGEN_', 'GT_', 'ETA_MEASURE',
  'PHASE_SWEEP', 'SOAK_', 'OPENING_GATES_', 'OPENING_GT_',
]);
/** Exakta namn som också skrubbas. */
const SCRUB_EXACT = Object.freeze(['FUSION_PASS', 'INV21_GT', 'AIS_BRIDGE_SELFTEST', 'NODE_ENV']);

function shouldScrub(name) {
  return SCRUB_EXACT.includes(name) || SCRUB_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Returnerar en skrubbad kopia av en miljö och namnen på det som togs bort.
 * @param {object} env - källmiljön (rörs inte)
 * @returns {{env: object, borttagna: string[]}} skrubbad miljö
 */
function scrubEnv(env) {
  const out = {};
  const borttagna = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (shouldScrub(k)) borttagna.push(k);
    else out[k] = v;
  }
  borttagna.sort();
  return { env: out, borttagna };
}

/**
 * Skrubbar föräldraprocessens egen miljö på plats. Föräldern kör harnessens
 * domare i-process (invariants, makeGtPassages), och de läser t.ex. INV21_GT
 * och GT_PASSAGES_DIR — en kvarglömd variabel i skalet får inte styra domen.
 * Anropas bara av hunt.js, aldrig av jest-tester.
 * @returns {string[]} namnen som togs bort
 */
function scrubOwnEnv() {
  const { borttagna } = scrubEnv(process.env);
  for (const k of borttagna) delete process.env[k];
  return borttagna;
}

/**
 * Miljön för ett replaybarn: skrubbad bas + egen TMPDIR (+ monitoring).
 * @param {object} baseEnv - föräldermiljön
 * @param {{tmpDir: string, monitoring?: boolean}} opts - tillägg
 * @returns {object} barnets miljö
 */
function childEnv(baseEnv, { tmpDir, monitoring = false }) {
  const { env } = scrubEnv(baseEnv);
  env.TMPDIR = tmpDir;
  env.TMP = tmpDir;
  env.TEMP = tmpDir;
  if (monitoring) env.REPLAY_MONITORING = '1';
  return env;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function git(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // Vakten får aldrig skriva i repot: inga valfria lås (index-refresh).
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (res.error) {
    return {
      ok: false, status: null, stdout: '', stderr: String(res.error.message),
    };
  }
  return {
    ok: res.status === 0, status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''),
  };
}

/**
 * Läser git-läget för repot. Repot räknas som git-repo bara om toppnivån är
 * exakt repots rot — en kopia som råkar ligga i en annan arbetskopia ska inte
 * vaktas mot fel repo.
 * @param {string} [root] - repots rot
 * @returns {{finns: boolean, sha: string|null, sha7: string, porcelain: string|null, ändrat: boolean|null, skäl?: string}} läge
 */
function gitInfo(root = REPO_ROOT) {
  const top = git(['rev-parse', '--show-toplevel'], root);
  if (!top.ok) {
    return {
      finns: false, sha: null, sha7: 'nogit', porcelain: null, ändrat: null, skäl: 'git saknas eller katalogen är inget git-repo',
    };
  }
  const toplevel = path.resolve(top.stdout.trim());
  let same = toplevel === path.resolve(root);
  try {
    same = same || fs.realpathSync(toplevel) === fs.realpathSync(root);
  } catch (e) { /* jämförelsen ovan gäller */ }
  if (!same) {
    return {
      finns: false, sha: null, sha7: 'nogit', porcelain: null, ändrat: null, skäl: `git-toppnivån ${toplevel} är inte repots rot`,
    };
  }
  const head = git(['rev-parse', 'HEAD'], root);
  const sha = head.ok ? head.stdout.trim() : null;
  const status = git(['status', '--porcelain'], root);
  const porcelain = status.ok ? status.stdout : null;
  return {
    finns: true, sha, sha7: sha ? sha.slice(0, 7) : 'nohead', porcelain, ändrat: porcelain === null ? null : porcelain.trim() !== '',
  };
}

/**
 * Är sökvägen git-ignorerad? null = går inte att avgöra (inget git).
 * @param {string} p - sökväg (behöver inte finnas)
 * @param {string} [root] - repots rot
 * @returns {boolean|null} svar
 */
function isGitIgnored(p, root = REPO_ROOT) {
  const res = git(['check-ignore', '-q', p], root);
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return null;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Utkatalog och tempkatalog
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** ÅÅÅÅMMDD-HHMMSS i lokal tid. */
function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Motorns egna baskataloger (resolveOutDir:s källor). Bara där skrivs
 * senaste.txt; en --out-katalogs förälder är ägarens och rörs aldrig.
 */
const EGNA_BASKÄLLOR = Object.freeze(['dirigent', 'tmpdir']);

/**
 * Väljer utkatalog enligt §3. Skapar inget. Med --out är `bas` null: då
 * skrivs ingenting utanför utkatalogen (ingen senaste.txt i föräldern).
 * @param {object} opts - {root, gitLäge, profil, seed, out, now}
 * @returns {{dir: string, bas: string|null, källa: string, varningar: string[], fel: string|null}} beslut
 */
function resolveOutDir({
  root = REPO_ROOT, gitLäge, profil, seed, out = null, now = new Date(),
}) {
  const name = `${stamp(now)}-${gitLäge && gitLäge.sha7 ? gitLäge.sha7 : 'nogit'}-${profil}-s${seed}`;
  const varningar = [];
  if (out) {
    const dir = path.resolve(out);
    if (isInside(dir, root)) {
      if (gitLäge && gitLäge.finns) {
        if (isGitIgnored(dir, root) !== true) {
          return {
            dir, bas: null, källa: 'flagga', varningar, fel: `--out=${out} ligger i repot men är inte git-ignorerad`,
          };
        }
      } else {
        varningar.push('--out ligger i repokatalogen men git saknas — ignorering kan inte kontrolleras');
      }
    }
    return {
      dir, bas: null, källa: 'flagga', varningar, fel: null,
    };
  }
  const dirigentHunt = path.join(root, 'dirigent', 'hunt');
  if (gitLäge && gitLäge.finns && isGitIgnored(path.join(dirigentHunt, name), root) === true) {
    return {
      dir: path.join(dirigentHunt, name), bas: dirigentHunt, källa: 'dirigent', varningar, fel: null,
    };
  }
  varningar.push(gitLäge && gitLäge.finns
    ? 'dirigent/hunt/ är inte git-ignorerad — utdata läggs i os.tmpdir()'
    : 'git saknas — utdata läggs i os.tmpdir()');
  const bas = path.join(os.tmpdir(), 'ais-tracker-hunt');
  return {
    dir: path.join(bas, name), bas, källa: 'tmpdir', varningar, fel: null,
  };
}

/**
 * Skapar körningens tempkatalog under os.tmpdir().
 * @param {string} runId - körnings-id
 * @returns {string} katalogen
 */
function makeTempDir(runId) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ais-tracker-hunt-${runId}-`));
}

function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* bästa försök */ }
}

/**
 * senaste.txt:s plats, eller null när den inte ska skrivas. Den skrivs bara
 * i motorns egna baskataloger (dirigent/hunt/ och os.tmpdir()/ais-tracker-hunt/);
 * med --out skrivs ingenting utanför utkatalogen.
 * @param {{bas?: string|null, källa?: string}} ut - resolveOutDir-beslutet
 * @returns {string|null} sökväg
 */
function senastePath(ut) {
  if (!ut || !ut.bas || !EGNA_BASKÄLLOR.includes(ut.källa)) return null;
  return path.join(ut.bas, 'senaste.txt');
}

/** Det en motorkörning skriver i sin utkatalog (BUGGJAKT §9). */
const MOTORNS_UTDATA = Object.freeze(['fynd', 'rapport.json', 'rapport.md']);

/**
 * Kringfiler som får ligga i utkatalogen och lämnas orörda: vanliga filer
 * med ändelsen .log, alltså körningens egen logg (`hunt.js … --out=X 2>&1 |
 * tee X/hunt.log` skapar filen innan motorn startar) eller en tidigare
 * körnings logg. Motorn skriver aldrig sådana filer och tömmer dem aldrig.
 */
const KRINGFIL_RE = /\.log$/i;

function isKringfil(dir, name) {
  if (!KRINGFIL_RE.test(name)) return false;
  try {
    return fs.statSync(path.join(dir, name)).isFile();
  } catch (e) {
    return false;
  }
}

/**
 * Får utkatalogen användas? Den får saknas eller vara tom, eller innehålla
 * EN tidigare motorkörning och inget annat: rapport.json med motorns
 * rapportformat och i övrigt bara rapport.md och fynd/. Kringfiler (*.log,
 * se ovan) får finnas i båda fallen och lämnas orörda (efterrättning D:
 * förut vägrades `--out=X` när körningens egen logg låg i X). Allt annat
 * vägras, så att en gammal körnings fynd aldrig blandas med en ny och ingen
 * annan katalog töms av misstag. Skapar och raderar inget.
 * @param {string} dir - utkatalogen
 * @param {{format: string}} opts - rapportformatet (report.FORMAT)
 * @returns {{ok: boolean, tidigare: boolean, fel: string|null}} beslut
 */
function checkOutDir(dir, { format }) {
  let entries;
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, tidigare: false, fel: `${dir} finns men är ingen katalog` };
    entries = fs.readdirSync(dir).sort().filter((e) => !isKringfil(dir, e));
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, tidigare: false, fel: null };
    return { ok: false, tidigare: false, fel: `${dir} kan inte läsas (${e.code || e.message})` };
  }
  if (!entries.length) return { ok: true, tidigare: false, fel: null };
  let tidigareFormat = null;
  try {
    tidigareFormat = JSON.parse(fs.readFileSync(path.join(dir, 'rapport.json'), 'utf8')).format || null;
  } catch (e) { /* saknas eller trasig: ingen tidigare motorkörning */ }
  const främmande = entries.filter((e) => !MOTORNS_UTDATA.includes(e));
  if (tidigareFormat === format && !främmande.length) return { ok: true, tidigare: true, fel: null };
  const skäl = tidigareFormat === format
    ? `innehåller annat än en tidigare motorkörning (${främmande.slice(0, 4).join(', ')}${främmande.length > 4 ? ' …' : ''})`
    : `saknar en rapport.json med formatet ${format} (bara loggfiler, *.log, får ligga där i övrigt)`;
  return {
    ok: false, tidigare: false, fel: `${dir} är inte tom och ${skäl} — välj en ny eller tom katalog`,
  };
}

/**
 * Förbereder utkatalogen precis före skrivningen: skapar den, eller tömmer en
 * tidigare motorkörnings fynd/, rapport.md och rapport.json (inget annat;
 * kringfilerna *.log lämnas orörda).
 * Kastar om katalogen inte får användas (se checkOutDir).
 * @param {string} dir - utkatalogen
 * @param {{format: string}} opts - rapportformatet
 * @returns {{ok: boolean, tidigare: boolean, fel: string|null}} beslutet
 */
function prepareOutDir(dir, { format }) {
  const c = checkOutDir(dir, { format });
  if (!c.ok) throw new Error(c.fel);
  if (c.tidigare) for (const e of MOTORNS_UTDATA) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return c;
}

/**
 * Git-vaktens jämförelse före/efter.
 * @param {object} före - gitInfo före
 * @param {object} efter - gitInfo efter
 * @returns {{ok: boolean, kontrollerad: boolean, skillnad: string[]}} utfall
 */
function compareGit(före, efter) {
  if (!före || !före.finns || före.porcelain === null || !efter || efter.porcelain === null) {
    return { ok: true, kontrollerad: false, skillnad: [] };
  }
  if (före.porcelain === efter.porcelain) return { ok: true, kontrollerad: true, skillnad: [] };
  const a = new Set(före.porcelain.split('\n').filter(Boolean));
  const b = new Set(efter.porcelain.split('\n').filter(Boolean));
  const skillnad = [
    ...[...b].filter((x) => !a.has(x)).map((x) => `+ ${x}`),
    ...[...a].filter((x) => !b.has(x)).map((x) => `- ${x}`),
  ];
  return { ok: false, kontrollerad: true, skillnad };
}

/**
 * Körnings-id = HEAD-sha + kalibreringshash + motorversion + profil + seed,
 * hashat till 12 hex så att det går att använda i katalognamn.
 * @param {object} parts - delarna
 * @returns {string} id
 */
function runIdOf({
  sha, kalibrering, motorversion, profil, seed,
}) {
  const text = [sha || 'nogit', kalibrering || 'okalibrerad', motorversion, profil, seed].join('|');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

module.exports = {
  REPO_ROOT,
  SCRUB_PREFIXES,
  SCRUB_EXACT,
  shouldScrub,
  scrubEnv,
  scrubOwnEnv,
  childEnv,
  git,
  gitInfo,
  isGitIgnored,
  isInside,
  stamp,
  EGNA_BASKÄLLOR,
  MOTORNS_UTDATA,
  KRINGFIL_RE,
  resolveOutDir,
  senastePath,
  checkOutDir,
  prepareOutDir,
  makeTempDir,
  removeDir,
  compareGit,
  runIdOf,
};
