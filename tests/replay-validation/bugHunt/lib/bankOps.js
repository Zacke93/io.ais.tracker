'use strict';

/**
 * Bankoperationer (BUGGJAKT §5): läsa korpusar och skriva varianter.
 *
 * Porterat från design-mutation/proto/huntLib.js och ops.js, med två
 * skärpningar:
 *   - tidsförskjutningen BEVARAR TYPEN per fält (tal förblir tal, ISO-sträng
 *     förblir ISO-sträng) — samma kontrakt som runPhaseSweep.shiftTimeField;
 *   - mmsi-bijektionen byggs ur BÅDE raderna och starttillståndet, så att ett
 *     fartyg som bara finns i state också får sitt nya id konsekvent.
 *
 * Varje variant schemavalideras före skrivning, får ett unikt basnamn
 * (`<korpus>.<tagg>.jsonl`, så att makeGtPassages.idForJsonl aldrig slår upp
 * en korpus facit för en variant) och får en `.state.json` bredvid sig bara
 * när korpusen har state.
 */

const fs = require('fs');
const path = require('path');
const corpora = require('../../corpora');
const schema = require('./schema');
const { fromEntries } = require('./util');

const EPOCH_MIN = schema.MIN_EPOCH_MS;
const EPOCH_MAX = schema.MAX_EPOCH_MS;
const SHIFTED_FIELDS = Object.freeze(['aisTimestamp', 'fixTs', 'receivedAt']);
const MMSI_RE = /(?<!\d)\d{9}(?!\d)/g;

/** state-sökvägen bredvid en jsonl (replayRunners egen konvention). */
function statePathFor(jsonl) {
  return jsonl.replace(/\.jsonl$/, '.state.json');
}

/**
 * Korpusarna i corpora.js-ordning, eventuellt en delmängd.
 * @param {string[]|null} ids - delmängd eller null för hela banken
 * @returns {object[]} korpusposter
 */
function corpusList(ids = null) {
  if (!ids || !ids.length) return [...corpora];
  const unknown = ids.filter((id) => !corpora.some((c) => c.id === id));
  if (unknown.length) throw new Error(`okänd korpus: ${unknown.join(', ')} (kända: ${corpora.map((c) => c.id).join(', ')})`);
  return corpora.filter((c) => ids.includes(c.id));
}

/**
 * Läser en korpus: raderna i filordning och starttillståndet om det finns.
 * @param {object} corpus - post ur corpora.js
 * @returns {object} {id, jsonl, rader, state, statePath, simTimmar}
 */
function readCorpus(corpus) {
  const text = fs.readFileSync(corpus.jsonl, 'utf8');
  const parsed = schema.parseJsonl(text);
  if (parsed.fel.length) throw new Error(`${corpus.id}: ${parsed.fel.join('; ')}`);
  const sp = statePathFor(corpus.jsonl);
  const state = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null;
  const ts = parsed.rader.map((r) => r.aisTimestamp).filter(Number.isFinite);
  return {
    id: corpus.id,
    jsonl: corpus.jsonl,
    rader: parsed.rader,
    state,
    statePath: state ? sp : null,
    simTimmar: ts.length ? (Math.max(...ts) - Math.min(...ts)) / 3.6e6 : 0,
  };
}

/** Flyttar alla epok-ms-tal i [1,5e12; 4,1e12], även nästlade. Strängar och andra tal rörs inte. */
function shiftEpochDeep(v, deltaMs) {
  if (typeof v === 'number') return (Number.isFinite(v) && v >= EPOCH_MIN && v <= EPOCH_MAX) ? v + deltaMs : v;
  if (Array.isArray(v)) return v.map((x) => shiftEpochDeep(x, deltaMs));
  if (v && typeof v === 'object') return fromEntries(Object.entries(v).map(([k, x]) => [k, shiftEpochDeep(x, deltaMs)]));
  return v;
}

function mapGet(map, key) {
  if (map instanceof Map) return map.get(key);
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Byter mmsi i nycklar och värden av formerna `mmsi`, `mmsi:Bro` och
 * `Bro|mmsi|riktning` (och i heltal som är kända mmsi).
 * @param {*} v - värdet
 * @param {Map|object} map - gammalt mmsi → nytt mmsi (strängar)
 * @returns {*} nytt värde
 */
function relabelDeep(v, map) {
  const sub = (s) => s.replace(MMSI_RE, (m) => mapGet(map, m) || m);
  if (typeof v === 'string') return sub(v);
  if (typeof v === 'number') {
    const hit = Number.isInteger(v) ? mapGet(map, String(v)) : undefined;
    return hit ? Number(hit) : v;
  }
  if (Array.isArray(v)) return v.map((x) => relabelDeep(x, map));
  if (v && typeof v === 'object') return fromEntries(Object.entries(v).map(([k, x]) => [sub(k), relabelDeep(x, map)]));
  return v;
}

/**
 * Skiftar ETT tidsfält och bevarar typen (tal → tal, ISO → ISO).
 * @returns {boolean} true om fältet fanns och skiftades
 */
function shiftTimeField(obj, field, deltaMs) {
  const v = obj[field];
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return false;
    obj[field] = v + deltaMs;
    return true;
  }
  if (typeof v === 'string' && v !== '') {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) return false;
    obj[field] = new Date(ms + deltaMs).toISOString();
    return true;
  }
  return false;
}

const ISO_FULL_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

/**
 * Som shiftEpochDeep, men flyttar även strängar som i sin helhet är en
 * ISO-tid (resultatets iso-fält). Används för att föra tillbaka ett helt
 * replayresultat till basens tidsram (SHIFT30: "allt ska vara lika efter t − Δ").
 */
function shiftTimesDeep(v, deltaMs) {
  if (typeof v === 'string') {
    if (!ISO_FULL_RE.test(v)) return v;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms + deltaMs).toISOString() : v;
  }
  if (typeof v === 'number') return (Number.isFinite(v) && v >= EPOCH_MIN && v <= EPOCH_MAX) ? v + deltaMs : v;
  if (Array.isArray(v)) return v.map((x) => shiftTimesDeep(x, deltaMs));
  if (v && typeof v === 'object') return fromEntries(Object.entries(v).map(([k, x]) => [k, shiftTimesDeep(x, deltaMs)]));
  return v;
}

/** Flyttar alla rader deltaMs (aisTimestamp, fixTs, receivedAt — typbevarande). */
function shiftRows(rows, deltaMs) {
  return rows.map((r) => {
    const x = { ...r };
    for (const f of SHIFTED_FIELDS) if (f in x) shiftTimeField(x, f, deltaMs);
    return x;
  });
}

/**
 * Den ordningsomvända bijektionen m → 999 999 999 − m för alla 9-siffriga
 * mmsi i raderna och i state (nycklar och strängvärden).
 * @param {object[]} rows - raderna
 * @param {object|null} state - starttillståndet
 * @returns {Map<string,string>} mappningen
 */
function mmsiBijection(rows, state = null) {
  const seen = new Set();
  for (const r of rows) if (!r.ctrl && /^\d{9}$/.test(String(r.mmsi))) seen.add(String(r.mmsi));
  if (state) {
    const text = JSON.stringify(state);
    for (const m of text.match(MMSI_RE) || []) seen.add(m);
  }
  const map = new Map();
  for (const m of [...seen].sort()) {
    const n = String(999999999 - Number(m));
    if (n.length !== 9) throw new Error(`mmsi ${m} ger inget 9-siffrigt id under bijektionen`);
    map.set(m, n);
  }
  return map;
}

/** Inversen av en mappning. */
function invertMap(map) {
  return new Map([...map.entries()].map(([a, b]) => [b, a]));
}

/** Byter mmsi på positionsraderna. */
function relabelRows(rows, map) {
  return rows.map((r) => (r.ctrl ? { ...r } : { ...r, mmsi: map.get(String(r.mmsi)) || r.mmsi }));
}

/**
 * Skriver en variant (schemavaliderad) med unikt basnamn.
 * @param {{dir: string, korpusId: string, tagg: string, rader: object[], state: object|null}} v - varianten
 * @returns {{jsonl: string, statePath: string|null, rader: number}} sökvägar
 */
function writeVariant({
  dir, korpusId, tagg, rader, state,
}) {
  const jsonl = path.join(dir, `${korpusId}.${tagg}.jsonl`);
  schema.assertValidRows(rader, path.basename(jsonl));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jsonl, `${rader.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const sp = statePathFor(jsonl);
  if (state) fs.writeFileSync(sp, JSON.stringify(state));
  else if (fs.existsSync(sp)) fs.unlinkSync(sp);
  return { jsonl, statePath: state ? sp : null, rader: rader.length };
}

/** Fastagg för δ: fas+7, fas-11.52. */
function phaseTag(deltaS) {
  return `fas${deltaS > 0 ? '+' : ''}${deltaS}`;
}

/** gt-passages för en korpus, flyttade deltaMs (t, tFrom, tTo, tFix). */
function shiftGt(gt, deltaMs) {
  if (!Array.isArray(gt)) return gt;
  return gt.map((g) => {
    const x = { ...g };
    for (const f of ['t', 'tFrom', 'tTo', 'tFix']) if (Number.isFinite(x[f])) x[f] += deltaMs;
    if (typeof x.iso === 'string' && Number.isFinite(x.t)) x.iso = new Date(Math.round(x.t)).toISOString();
    return x;
  });
}

module.exports = {
  SHIFTED_FIELDS,
  statePathFor,
  corpusList,
  readCorpus,
  shiftEpochDeep,
  shiftTimesDeep,
  relabelDeep,
  shiftTimeField,
  shiftRows,
  mmsiBijection,
  invertMap,
  relabelRows,
  writeVariant,
  phaseTag,
  shiftGt,
};
