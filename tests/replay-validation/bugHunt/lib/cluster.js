'use strict';

/**
 * Mekanismklustring (BUGGJAKT §8–9).
 *
 * Identiteten är mekanismen — `orakel | normaliserad klass` — inom samma
 * registerutfall: ett KANDIDAT-utslag och ett ACCEPTERAT utslag av samma
 * mekanism är olika kluster, eftersom de hör hemma i olika avsnitt av
 * rapporten. Bro, riktning, era, profil, familj, korpus, δ och taggar är
 * METADATA och redovisas som fördelningar.
 *
 * Sanningsspårets fynd ur världar med uppmätt stresstäthet (nivå 'stress',
 * BUGGJAKT §4.4) bildar egna kluster (`| stress` i nyckeln): de redovisas i
 * en egen sektion med nivåvikt 0,3 och räknas aldrig som oberoende enheter i
 * ett R0- eller R1-kluster.
 *
 * Poäng = allvar × nivåvikt × (1 + log2(oberoende världar eller korpusar))
 *         × 0,8 när alla utslag är KNIVSEGG.
 * Sorteringen är deterministisk: poäng (fallande), sedan klusternyckel.
 *
 * Klustren slås aldrig ihop över mekanismgränsen, men rapporten länkar
 * tvillingkort (BUGGJAKT §8–9, runda 2 E8). Relationerna här är rena
 * funktioner: stresstvillingens nyckel (`utanStress`), det minsta reprots
 * identitet (`reproIdentitet`) och samma utslag i två kluster
 * (`utslagsfönster`, `sammaUtslag`).
 */

const { NIVÅVIKT, KNIVSEGG_FAKTOR } = require('./profiles');
const { mechanismOf, sortFindings } = require('./finding');
const signature = require('./signature');
const { fromEntries, cmpStr } = require('./util');

const NIVÅ_ORDNING = Object.freeze(['R0', 'bank', 'R1', 'stress']);

/**
 * Klusternyckeln — påverkas inte av bro, riktning, era eller taggar.
 * Sanningsspårets fynd (syntetiska världar) klustras för sig: verklig data
 * (bank, självtest) och syntetik hör hemma i olika avsnitt av rapporten, och
 * ett KNIVSEGG-fynd ur banken får inte färgas av en syntetisk R0-värld.
 * Stressvärldarnas fynd klustras dessutom för sig (`|stress`): stress
 * redovisas i en egen sektion med egen nivåvikt (BUGGJAKT §4.4 och §9).
 */
function clusterKey(f) {
  const reg = f.register || {};
  const synt = f.spår === 'synth';
  return `${reg.klass || 'KANDIDAT'}|${reg.post || '-'}|${mechanismOf(f)}${synt ? '|synt' : ''}${synt && f.nivå === 'stress' ? '|stress' : ''}`;
}

function bump(map, key) {
  if (key === null || key === undefined || key === '') return;
  const k = String(key);
  map[k] = (map[k] || 0) + 1;
}

function sortedObject(o) {
  return fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Oberoende enhet för ett fynd: korpus eller värld. */
function unitOf(f) {
  const u = f.ursprung || {};
  if (u.korpus) return `korpus:${u.korpus}`;
  if (u.värld !== undefined && u.värld !== null) return `värld:${u.värld}`;
  return 'okänd';
}

function bestLevel(levels) {
  for (const l of NIVÅ_ORDNING) if (levels.includes(l)) return l;
  return levels[0] || 'bank';
}

/**
 * Klustrar klassade fynd.
 * @param {object[]} findings - fynd med register-fältet ifyllt
 * @returns {object[]} kluster, sorterade
 */
function clusterFindings(findings) {
  const groups = new Map();
  for (const f of sortFindings(findings)) {
    const k = clusterKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const clusters = [];
  for (const [nyckel, fynd] of groups) {
    const first = fynd[0];
    const fördelning = {
      bro: {}, riktning: {}, nivå: {}, radio: {}, era: {}, familj: {}, korpus: {}, delta: {}, taggar: {}, spår: {},
    };
    const units = new Set();
    for (const f of fynd) {
      const u = f.ursprung || {};
      bump(fördelning.bro, f.bro);
      bump(fördelning.riktning, f.riktning);
      bump(fördelning.nivå, f.nivå);
      bump(fördelning.radio, u.radio);
      bump(fördelning.era, u.era);
      bump(fördelning.familj, u.familj);
      bump(fördelning.korpus, u.korpus);
      for (const d of u.deltaS || []) bump(fördelning.delta, d);
      for (const t of f.taggar || []) bump(fördelning.taggar, t);
      bump(fördelning.spår, f.spår);
      units.add(unitOf(f));
    }
    for (const k of Object.keys(fördelning)) fördelning[k] = sortedObject(fördelning[k]);
    const allvar = Math.max(...fynd.map((f) => f.allvar || 0));
    const nivå = bestLevel(Object.keys(fördelning.nivå));
    const knivsegg = fynd.every((f) => (f.taggar || []).includes('KNIVSEGG'));
    const oberoende = units.size;
    const poäng = scoreOf({
      allvar, nivå, oberoende, knivsegg,
    });
    clusters.push({
      nyckel,
      mekanism: mechanismOf(first),
      orakel: first.orakel,
      klass: first.klass,
      registerklass: (first.register && first.register.klass) || 'KANDIDAT',
      post: (first.register && first.register.post) || null,
      närmast: (first.register && first.register.närmast) || null,
      prövade: (first.register && first.register.prövade) || [],
      allvar,
      nivå,
      oberoende,
      knivsegg,
      låstBank: fynd.some((f) => (f.taggar || []).includes('LÅST-BANK')),
      räknare: fynd.every((f) => f.räknare),
      poäng,
      antal: fynd.length,
      fördelning,
      fynd,
    });
  }
  return sortClusters(clusters);
}

/**
 * Kortpoängen (BUGGJAKT §9).
 * @param {{allvar: number, nivå: string, oberoende: number, knivsegg: boolean}} c - kluster
 * @returns {number} poäng
 */
function scoreOf({
  allvar, nivå, oberoende, knivsegg,
}) {
  const vikt = NIVÅVIKT[nivå] === undefined ? 1 : NIVÅVIKT[nivå];
  return Math.round(allvar * vikt * (1 + Math.log2(Math.max(1, oberoende))) * (knivsegg ? KNIVSEGG_FAKTOR : 1) * 1000) / 1000;
}

/** Räknar om poängen efter bekräftelsen (ny nivå eller KNIVSEGG). */
function rescore(c) {
  c.poäng = scoreOf(c);
  return c;
}

/** Deterministisk ordning: poäng (fallande), sedan klusternyckel. */
function sortClusters(clusters) {
  return [...clusters].sort((a, b) => (b.poäng - a.poäng) || cmpStr(a.nyckel, b.nyckel));
}

/** Storleksmått för representantvalet: båtar × timmar (eller rader). */
function sizeOf(f) {
  const u = f.ursprung || {};
  if (Number.isFinite(u.båtar) && Number.isFinite(u.timmar)) return u.båtar * u.timmar;
  if (Number.isFinite(u.rader)) return u.rader;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Väljer upp till n representanter: helst R0, helst olika broar och den
 * minsta världen först (BUGGJAKT §8).
 * @param {object} cluster - kluster
 * @param {number} n - antal
 * @returns {object[]} representanter
 */
function chooseRepresentatives(cluster, n) {
  const rank = (f) => {
    const i = NIVÅ_ORDNING.indexOf(f.nivå);
    return i < 0 ? NIVÅ_ORDNING.length : i;
  };
  const ordered = [...cluster.fynd].sort((a, b) => (rank(a) - rank(b)) || (sizeOf(a) - sizeOf(b)));
  const out = [];
  const bridges = new Set();
  for (const f of ordered) {
    if (out.length >= n) break;
    if (!bridges.has(f.bro || '-')) {
      out.push(f);
      bridges.add(f.bro || '-');
    }
  }
  for (const f of ordered) {
    if (out.length >= n) break;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tvillingrelationer (BUGGJAKT §8–9; runda 2, E8). Korten slås inte ihop —
// klustringen per mekanism är avsiktlig — men rapporten länkar dem.
// ---------------------------------------------------------------------------

const STRESS_SUFFIX = '|stress';

/**
 * Klusternyckeln utan nivån stress. Ett stresskluster och klustret med samma
 * nyckel utan `|stress` är stresstvillingar: samma registerutfall och samma
 * mekanism, bara olika täthetsnivå (§8).
 * @param {string} nyckel - klusternyckel
 * @returns {string} nyckeln utan `|stress`
 */
function utanStress(nyckel) {
  const k = String(nyckel || '');
  return k.endsWith(STRESS_SUFFIX) ? k.slice(0, -STRESS_SUFFIX.length) : k;
}

/**
 * Identiteten för en representants minsta repro: radhashen (sha256 över
 * repro.jsonl:s rader, synthLane.hashRows) och monitoringläget, som ingår i
 * replaykommandot. Bara en krympt representant har ett minsta repro; en
 * okrympt bär hela världens radhash, som inte säger något om utslaget.
 * @param {object} f - representantens fynd
 * @returns {string|null} identiteten eller null
 */
function reproIdentitet(f) {
  const repro = f && f.repro;
  const recept = repro && repro.recept;
  if (!repro || !repro.krympt || !recept || !recept.radHash) return null;
  return `${recept.radHash}|monitoring=${recept.monitoring ? 1 : 0}`;
}

/** Epok-ms ur ett tal eller en ISO-tid, annars null. */
function epokMs(v) {
  if (Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Invariantklasser med en episodlängd i texten. ETA-SÅGTAND UPP ("på Ns",
 * invariants.js:321) och ETA-OSCILLATION ("inom Ns", :351) har sin tid i
 * episodens SLUT; DEFAULT-FLASH ("(Ns)", :170–180) har sin tid i STARTEN.
 * Samma tolkning som registrets SLUTTIDSKLASSER (registry.js, episodLängdMs).
 */
const EPISODKLASSER = Object.freeze({
  'ETA-SÅGTAND UPP': { re: /\bpå (\d+(?:[.,]\d+)?)s\b/, slut: true },
  'ETA-OSCILLATION': { re: /\binom (\d+(?:[.,]\d+)?)s\b/, slut: true },
  'DEFAULT-FLASH': { re: /\((\d+(?:[.,]\d+)?)s\)/, slut: false },
});

/**
 * Utslagets tidsfönster [från, till] i epok-ms (bankfynd i basens tidsram).
 * Fönstret spänner över fyndets tid och händelseparet som oraklet jämför,
 * när belägget har det: korsningen (korsningT, korsning.t), varningen,
 * den sanna passagen, notisen, den registrerade passagen och T1:s besök.
 * Kontextfält som senasteFix, fixFöre/fixEfter, förraNotis,
 * varningarFörBron och senasteVändning ingår inte: de beskriver vad som
 * hände före utslaget, inte utslaget. Invariantutslag med episodlängd
 * (EPISODKLASSER) och STRAX-ZOMBIE:s väntan sträcker fönstret över hela
 * episoden. Fynd utan tid (H1–H3) har inget fönster.
 * @param {object} f - fynd
 * @returns {{från: number, till: number}|null} fönstret
 */
function utslagsfönster(f) {
  if (!f || !Number.isFinite(f.t)) return null;
  const b = f.belägg || {};
  const del = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
  const tider = [f.t, b.korsningT, del(b.korsning, 't'), del(b.varning, 't'), del(b.sannPassage, 't'),
    del(b.notis, 't'), del(b.passage, 't'), del(b.besök, 'tIn'), del(b.besök, 'tOut')]
    .map(epokMs).filter(Number.isFinite);
  let från = Math.min(...tider);
  let till = Math.max(...tider);
  const msg = String(b.meddelande || f.detalj || '');
  const episod = EPISODKLASSER[signature.classOf(msg)];
  const m = episod ? episod.re.exec(msg) : null;
  if (m) {
    const längdMs = Number(m[1].replace(',', '.')) * 1000;
    if (episod.slut) från = Math.min(från, f.t - längdMs);
    else till = Math.max(till, f.t + längdMs);
  }
  const väntan = b.väntan || {};
  if (Number.isFinite(väntan.från) && Number.isFinite(väntan.till)) {
    från = Math.min(från, väntan.från);
    till = Math.max(till, väntan.till);
  }
  return { från, till };
}

/**
 * Underlaget som ett utslag kommer ur: korpusen (bankens och självtestets
 * fynd, i basens tidsram) eller sanningsspårets värld. Kanarier och fynd
 * utan underlag ger null och länkas aldrig.
 * @param {object} f - fynd
 * @returns {string|null} enhetsnyckel
 */
function underlagOf(f) {
  const u = (f && f.ursprung) || {};
  if (u.korpus) return `korpus:${u.korpus}`;
  if (u.värld !== undefined && u.värld !== null) return `${f.spår || '-'}|värld:${u.värld}`;
  return null;
}

/**
 * Var ett utslag sker: underlag, bro och fartyg (null utan underlag). Två
 * fynd kan bara vara samma utslag när nycklarna är lika.
 * @param {object} f - fynd
 * @returns {string|null} nyckel
 */
function utslagsplats(f) {
  const u = underlagOf(f);
  return u ? `${u}|${f.bro || '-'}|${f.mmsi || '-'}` : null;
}

/**
 * Är två utslag samma utslag, sett från två orakel? Samma underlag (värld
 * eller korpus), samma bro, samma fartyg (eller fartyg saknas i båda) och
 * överlappande utslagsfönster, utan tolerans. Ett fynd utan fartyg (ett
 * textutslag som INV-3) möter alltså bara andra fynd utan fartyg.
 * @param {object} a - fynd
 * @param {object} b - fynd
 * @returns {boolean} samma utslag
 */
function sammaUtslag(a, b) {
  const pa = utslagsplats(a);
  if (!pa || pa !== utslagsplats(b)) return false;
  const fa = utslagsfönster(a);
  const fb = utslagsfönster(b);
  return !!(fa && fb && fa.från <= fb.till && fb.från <= fa.till);
}

module.exports = {
  NIVÅ_ORDNING,
  clusterKey,
  unitOf,
  clusterFindings,
  chooseRepresentatives,
  scoreOf,
  rescore,
  sortClusters,
  utanStress,
  reproIdentitet,
  utslagsfönster,
  underlagOf,
  utslagsplats,
  sammaUtslag,
};
