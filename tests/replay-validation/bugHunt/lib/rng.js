'use strict';

/**
 * Seedad slump för buggjägarens sanningsspår (BUGGJAKT.md §3, §4.2).
 *
 * mulberry32 är samma generator som scenarioGenerator använder. Varje
 * konsument får en EGEN ström ur (seed, etikett): världen, varje båts radio
 * (`radio-<mmsi>`), varje båts sidledsbrus (`lat-<mmsi>`) och värld i
 * (`värld-<i>`). Därför kan krympningen ta bort en båt utan att de andra
 * båtarnas observationer ändras, och samma värld kan observeras med olika
 * radio.
 *
 * Inga globala tillstånd och inga timers: modulen är ren.
 */

const crypto = require('crypto');

/**
 * mulberry32 — 32-bitars PRNG med perioden 2^32.
 * @param {number} seed - startvärde (tolkas som uint32)
 * @returns {function(): number} likformigt tal i [0, 1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a (32 bitar) över etiketten, blandad med seed. Deterministisk och
 * plattformsoberoende (UTF-16-koder, inga locale-beroenden).
 * @param {number} seed - bas-seed
 * @param {string} label - etikett
 * @returns {number} uint32
 */
function hash32(seed, label) {
  let h = 2166136261 ^ (seed >>> 0);
  const s = String(label);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Härled ett nytt seed ur (seed, etikett), t.ex. värld i:
 * `deriveSeed(basSeed, 'värld-' + i)`. Resultatet ligger i [1, 2^31 − 1] så
 * att det går att skriva i JSON och läsa tillbaka utan förlust.
 * @param {number} seed - bas-seed
 * @param {string} label - etikett
 * @returns {number} härlett seed
 */
function deriveSeed(seed, label) {
  const r = mulberry32(hash32(seed, label));
  return 1 + Math.floor(r() * 2147483646);
}

/**
 * En namngiven slumpström med bekväma fördelningar.
 * @param {number} seed - bas-seed
 * @param {string} label - strömmens etikett
 * @returns {object} {u, range, int, pick, chance, weighted, normal}
 */
function stream(seed, label) {
  const r = mulberry32(hash32(seed, label));
  return {
    u: () => r(),
    range: (a, b) => a + ((b - a) * r()),
    int: (a, b) => a + Math.floor((b - a + 1) * r()),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    // pairs = [[värde, vikt], …]; vikter behöver inte summera till 1.
    weighted: (pairs) => {
      const tot = pairs.reduce((s, [, w]) => s + w, 0);
      let x = r() * tot;
      for (const [v, w] of pairs) {
        x -= w;
        if (x <= 0) return v;
      }
      return pairs[pairs.length - 1][0];
    },
    // Box–Muller, N(0; 1).
    normal: () => {
      const u1 = Math.max(1e-12, r());
      const u2 = r();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

/**
 * Djupfrys ett objekt (spec). Varje skrivförsök i strict mode kastar då —
 * prototypens radio skrev nameUnknownMin i specen och bröt rundresan.
 * @param {*} o - objekt
 * @returns {*} samma objekt, fryst
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/**
 * SHA-256 över rader i jsonl-form (samma serialisering som skrivs till disk).
 * @param {object[]} rows - rader
 * @returns {string} hex
 */
function hashRows(rows) {
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(`${JSON.stringify(r)}\n`);
  return h.digest('hex');
}

/**
 * SHA-256 över en godtycklig JSON-serialiserbar struktur med sorterade
 * nycklar, så att nyckelordningen inte påverkar hashen.
 * @param {*} value - värde
 * @returns {string} hex
 */
function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * JSON.stringify med sorterade nycklar på alla nivåer.
 * @param {*} value - värde
 * @returns {string} JSON
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Object.fromEntries-ersättare (eslint-config-athom sätter node >= 8, samma
 * lösning som coverageMap.fromPairs).
 * @param {Iterable} pairs - [nyckel, värde]-par
 * @returns {object} objekt
 */
function fromPairs(pairs) {
  const out = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

module.exports = {
  mulberry32, hash32, deriveSeed, stream, deepFreeze, hashRows, hashJson, stableStringify, fromPairs,
};
