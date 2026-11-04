'use strict';

/**
 * Små hjälpare utan beroenden. eslint-config-athom sätter node ≥ 8, så
 * Object.fromEntries (Node 12) används inte direkt — samma val som
 * coverageMap.js gör.
 */

/** Object.fromEntries-ersättare. */
function fromEntries(pairs) {
  const out = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

/** Kopierar en fil (fs.copyFileSync kräver Node 8.5). */
function copyFile(fs, from, to) {
  fs.writeFileSync(to, fs.readFileSync(from));
}

/** Deterministisk strängjämförelse (−1, 0, 1) utan nästlade ternärer. */
function cmpStr(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

module.exports = { fromEntries, copyFile, cmpStr };
